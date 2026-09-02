import { describe, expect, test } from "bun:test";
import type { Said } from "../../src/contracts/said.ts";
import { renderSaid } from "../../src/platform/text/lang.ts";
import { said } from "../support/said.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openMemory, writeSetting } from "../../src/platform/persistence/database.ts";
import {
  allowedHostPaths,
  coveredBy,
  forgetSessions,
  restartServer,
  runIn,
  unwrap,
  wrapForSession,
} from "../../src/mech/sandbox/sandbox.ts";
import { preflight, strandedCheck } from "../../src/mech/ops/preflight.ts";
import { serverAction, serverBackoffMs, SERVER_RESTART_CAP } from "../../src/mech/ops/watchdog.ts";
import { patchConfig, startPlan, waitUp } from "../../src/mech/sandbox/server.ts";
import { testContext } from "../support/test-context.ts";
import { tempDir } from "../support/temp.ts";

/** The byte the wrapper brackets stderr with, written as an escape so this file stays text. */
const SOH = "\u0001";

/**
 * The sandbox server is the one host dependency that runs containers, and it
 * fails in three ways that look identical from the panel.
 *
 * The silent one is the reason this file exists: a config whose
 * `allowed_host_paths` does not cover what we mount. The process is healthy,
 * nothing errors, creation may even succeed — and every container gets an empty
 * directory where the skills should be. That is a whole day of agents running
 * with no skills and nothing to see.
 */

function configWith(line: string): string {
  const dir = tempDir("orch-toml-");
  const path = join(dir, "sandbox.toml");
  writeFileSync(path, `[server]\napi_key = "k"\n\n[sandbox]\n# Example: allowed_host_paths = ["/nope"]\n${line}\n`);
  return path;
}

test("the server's own allowlist is read from its own config, and a comment is not it", () => {
  const path = configWith(`allowed_host_paths = ["/var/tmp/orch-cache", "/Users/me/.orch-cache"]`);
  process.env.OPENSANDBOX_CONFIG = path;
  try {
    const found = allowedHostPaths()!;
    expect(found.config).toBe(path);
    // The example line above it is commented out. Taking it would report an
    // allowlist the server is not using — the same trap `keyInConfig` has.
    expect(found.paths).toEqual(["/var/tmp/orch-cache", "/Users/me/.orch-cache"]);
  } finally {
    delete process.env.OPENSANDBOX_CONFIG;
  }
});

/**
 * A mount is covered by a prefix directory, not by string equality.
 *
 * A table, so the failure names the path. As five assertions in one test this
 * printed `expected false, received true` and nothing about which of the five
 * mounts was asked — and the sibling case below is the one that matters.
 */
describe("a mount is covered by a prefix directory", () => {
  const allowed = ["/var/tmp/orch-cache", "/Users/me/.orch-cache/"];
  test.each([
    ["/var/tmp/orch-cache/skills", true],
    ["/var/tmp/orch-cache", true],
    // A trailing slash in the config is the boss's to write however they like.
    ["/Users/me/.orch-cache/skills", true],
    // Not a sibling that merely starts with the same characters.
    ["/var/tmp/orch-cache-other/skills", false],
    ["/Users/me/elsewhere", false],
  ])("%s covered: %p", (mount, covered) => {
    expect(coveredBy(allowed, mount)).toBe(covered);
  });
});

test("drift is reported with the line to paste, not a description of it", async () => {
  // This is the whole value of the check: one executable sentence. A boss who
  // has to work out the TOML from prose is a boss who leaves it broken.
  const path = configWith(`allowed_host_paths = ["/var/tmp/orch-cache"]`);
  process.env.OPENSANDBOX_CONFIG = path;
  try {
    const checks = await preflight({
      db: await openMemory(),
      sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" },
      skillsDir: "/Users/me/.orch-cache/skills",
      cacheDirs: { "/root/.bun/install/cache": "/Users/me/.orch-cache/bun" },
      probe: () => false,
      verify: async () => ({ ok: true, said: { id: "check.cred.accepted" } }),
    });
    const c = checks.find((x) => x.name === "allowed_host_paths")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("/Users/me/.orch-cache/skills");
    // Both wanted paths, and what was already there, in one pasteable line.
    expect(c.fix).toContain(
      `allowed_host_paths = ["/var/tmp/orch-cache", "/Users/me/.orch-cache/skills", "/Users/me/.orch-cache/bun"]`,
    );

    const ok = await preflight({
      db: await openMemory(),
      sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" },
      skillsDir: "/var/tmp/orch-cache/skills",
      probe: () => false,
      verify: async () => ({ ok: true, said: { id: "check.cred.accepted" } }),
    });
    expect(ok.find((x) => x.name === "allowed_host_paths")!.ok).toBe(true);
  } finally {
    delete process.env.OPENSANDBOX_CONFIG;
  }
});

test("a server that is present is never restarted, whatever it is doing", () => {
  // The guarantee this policy exists for. "Present but refusing" — a bad key, a
  // crash loop — is indistinguishable from healthy at this level, and restarting
  // it is how a crash loop becomes a restart loop. So presence ends the question.
  const argv = ["uvx", "opensandbox-server", "--config", "/x.toml"];
  expect(serverAction(true, argv, 0, 1_000_000, 0)).toBe("none");
  expect(serverAction(true, argv, SERVER_RESTART_CAP, 1_000_000, 0)).toBe("none");

  // Absent, and we know how it was started: restart it.
  expect(serverAction(false, argv, 0, 1_000_000, 0)).toBe("restart");

  // Absent, but never seen running: we would be guessing at the command line,
  // and a guess starts a second, differently-configured server.
  expect(serverAction(false, null, 0, 1_000_000, 0)).toBe("none");
  expect(serverAction(false, [], 0, 1_000_000, 0)).toBe("none");

  // Backing off, and then giving up rather than trying forever.
  expect(serverAction(false, argv, 1, 0, 30_000)).toBe("none");
  expect(serverAction(false, argv, SERVER_RESTART_CAP, 1_000_000, 0)).toBe("give_up");
  expect(serverBackoffMs(1)).toBe(30_000);
  expect(serverBackoffMs(3)).toBeGreaterThan(serverBackoffMs(2));
});

const LIVE_SERVER = { pid: "42", argv: ["opensandbox-server"], config: null };

function stuckServer(kill: (signal: "SIGTERM" | "SIGKILL") => void) {
  let starts = 0;
  return {
    ops: {
      running: () => LIVE_SERVER,
      kill: (_pid: number, signal: "SIGTERM" | "SIGKILL") => kill(signal),
      sleep: async () => {},
      start: () => {
        starts++;
      },
    },
    starts: () => starts,
  };
}

/** `restartServer` names its failure rather than writing it; these assert the English. */
const en = (said: Said | null): string => (said ? renderSaid("en", said) : "");

test("a failed SIGKILL cannot be reported as a successful restart", async () => {
  const server = stuckServer((signal) => {
    if (signal === "SIGKILL") throw new Error("operation not permitted");
  });

  const error = await restartServer(LIVE_SERVER.argv, undefined, server.ops);

  expect(en(error)).toContain("could not force-stop pid 42");
  expect(en(error)).toContain("operation not permitted");
  expect(server.starts()).toBe(0);
});

test("a process still alive after SIGKILL blocks a second server", async () => {
  const server = stuckServer(() => {});

  const error = await restartServer(LIVE_SERVER.argv, undefined, server.ops);

  expect(en(error)).toBe("pid 42 is still running after SIGKILL");
  expect(server.starts()).toBe(0);
});

test("a process stopped by SIGKILL is replaced exactly once", async () => {
  let alive = true;
  let starts = 0;
  const error = await restartServer(LIVE_SERVER.argv, undefined, {
    running: () => (alive ? LIVE_SERVER : null),
    kill: (_pid, signal) => {
      if (signal === "SIGKILL") alive = false;
    },
    sleep: async () => {},
    start: () => {
      starts++;
    },
  });

  expect(error).toBeNull();
  expect(starts).toBe(1);
});

/**
 * Starting one, and the three ways of not starting one.
 *
 * The rule is one-directional and the whole value is in the "no"s: a server we
 * did not start may be serving something else, and "I cannot drive it" is not
 * evidence that nobody can. Restarting there takes down whatever else was using
 * it, and from here that is indistinguishable from restarting the user's own
 * work.
 */

const HERE = "127.0.0.1:8080";

test("a server that is already there is handed back untouched, whatever state it is in", () => {
  for (const seen of [
    { kind: "ours", pid: "1" },
    { kind: "theirs", pid: "2" },
    { kind: "stuck", pid: "3", why: said("the API key does not match") },
  ] as const) {
    expect(startPlan(seen, HERE, true)).toEqual(seen);
  }
});

test("without uvx there is nothing to start, and the reason already says so", () => {
  // opensandbox-server is a Python package. Reporting "could not start" over
  // this would hide the one command that fixes it.
  const down = {
    kind: "down",
    why: said("no uvx — opensandbox-server is a Python package, so install uv before one can start"),
  } as const;
  expect(startPlan(down, HERE, false)).toEqual(down);
});

test("a remote address is never started locally, however silent it is", () => {
  // Pointed at a Tailscale peer or a cloud box, "nothing answers" means that
  // host is down. Spawning one here would bind a port nobody is asking about
  // and report success.
  const plan = startPlan({ kind: "down", why: said("not running") }, "sandbox.tailnet.ts.net:8080", true);
  expect(plan.kind).toBe("down");
  expect(plan.kind === "down" && renderSaid("en", plan.why)).toContain("not an address on this machine");
});

test("every shape of a local address is startable, including the IPv6 loopback", () => {
  for (const addr of ["localhost:8080", "127.0.0.1:8080", "127.5.5.5:9", "[::1]:8080", "https://LOCALHOST:8443"]) {
    expect(startPlan({ kind: "down", why: said("not running") }, addr, true).kind).toBe("start");
  }
});

/**
 * Waiting for one to come up, which is really waiting to find out why it did not.
 *
 * Watching the process as well as the port is the whole point: a server that
 * dies on a bad config dies in the first second, and polling alone would spend
 * the entire timeout before saying "cannot connect" — true, and not the reason.
 */

async function waiting(dataDir: string, log?: string) {
  if (log !== undefined) writeFileSync(join(dataDir, "opensandbox-server.log"), log);
  const ctx = await testContext();
  ctx.config = { ...ctx.config, dataDir };
  return ctx;
}

const never = async () => ({ kind: "none", why: said("Unable to connect") }) as const;

test("a server that dies on its config is reported with what it printed, not with our probe", async () => {
  const dir = tempDir("orch-srv-");
  const ctx = await waiting(dir, "pydantic_core.ValidationError: 1 validation error for AppConfig\n");
  const slept: number[] = [];

  const up = await waitUp(ctx, { exited: Promise.resolve(1) }, HERE, "k", 45_000, {
    probe: never,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });

  expect(up.ok).toBe(false);
  expect(renderSaid("en", up.why)).toContain("exit 1");
  expect(renderSaid("en", up.why)).toContain("ValidationError");
  // And it stops the moment the process is gone rather than sitting out the
  // whole 45 seconds on a process that is already dead.
  expect(slept).toEqual([]);
});

test("a process that died silently says that, rather than leaving a blank where the log goes", async () => {
  const ctx = await waiting(tempDir("orch-srv-"));

  const up = await waitUp(ctx, { exited: Promise.resolve(2) }, HERE, "k", 45_000, {
    probe: never,
    sleep: async () => {},
  });

  expect(renderSaid("en", up.why)).toContain("exit 2");
  expect(renderSaid("en", up.why)).toContain("printing nothing");
});

test("a server that never answers gives up at the deadline and says how long it waited", async () => {
  // Bounded, and it must stay bounded: this runs at boot and the settings page
  // waits on it.
  //
  // The deadline is real time — `waitUp` closes over `Date.now()`, and only its
  // `sleep` is injected — so this test costs whatever deadline it is given. 600ms
  // is the cheapest one that still rounds to the "after 1s" below, and it was
  // 1200ms: the same two assertions for twice the wall clock.
  const ctx = await waiting(tempDir("orch-srv-"), "Address already in use\n");
  let probes = 0;

  const up = await waitUp(ctx, { exited: new Promise<number>(() => {}) }, HERE, "k", 600, {
    probe: async () => {
      probes++;
      return { kind: "none", why: said("Unable to connect") };
    },
    sleep: async () => {},
  });

  expect(up.ok).toBe(false);
  expect(renderSaid("en", up.why)).toContain("after 1s");
  expect(renderSaid("en", up.why)).toContain("Address already in use");
  expect(probes).toBeGreaterThan(0);
});

test("a server holding somebody else's key is reported as that, not as unreachable", async () => {
  // The sentence this exists to stop: "起来了但驱动不了：Unable to connect",
  // which describes neither of the two things that were true.
  const ctx = await waiting(tempDir("orch-srv-"));

  const up = await waitUp(ctx, { exited: Promise.resolve(0) }, HERE, "k", 5000, {
    probe: async () => ({ kind: "auth" }),
    sleep: async () => {},
  });

  expect(up.ok).toBe(false);
  expect(renderSaid("en", up.why)).toContain("exit 0");
});

test("a server that comes up on a later probe is up, and the wait ends there", async () => {
  const ctx = await waiting(tempDir("orch-srv-"));
  let n = 0;

  const up = await waitUp(ctx, { exited: new Promise<number>(() => {}) }, HERE, "k", 10_000, {
    probe: async () => (++n < 3 ? { kind: "none" as const, why: said("no") } : { kind: "ok" as const }),
    sleep: async () => {},
  });

  expect(up.ok).toBe(true);
  expect(n).toBe(3);
});

/**
 * The values we patch into a generated config.
 *
 * `init-config --example docker` renders the rest, because a config file is that
 * package's schema and not ours. These six are the ones that have to agree with
 * us, and two of them have already cost a day each.
 */

const EXAMPLE = [
  "[server]",
  'host = "0.0.0.0"',
  "port = 9999",
  '# api_key = "your-secret-api-key"',
  "",
  "[ingress]",
  'mode = "gateway"',
  "",
  "[egress]",
  'image = "opensandbox/egress:v1.1.4"',
  'mode = "direct"',
  "",
].join("\n");

test("the section a key lives in decides which one is written", () => {
  // `mode` appears in [ingress] and [egress], and a file-wide `^mode =` replaced
  // the ingress one with `dns+nft`. The server then refused to start:
  // "Input should be 'direct' or 'gateway'".
  const out = patchConfig(EXAMPLE, { host: "127.0.0.1", port: "8080", key: "k", allowed: ["/Users/me"] });

  expect(out).toContain('[ingress]\nmode = "gateway"');
  expect(out).toContain('mode = "dns+nft"');
  expect(out.match(/mode = "dns\+nft"/g)!.length).toBe(1);
});

test("a commented-out key is the key, not an absent one", () => {
  // The generated example ships `# api_key = "your-secret-api-key"`. Treating
  // that as absent appended a second line and left the server reading the
  // commented one — no key at all, while we sent one.
  const out = patchConfig(EXAMPLE, { host: "127.0.0.1", port: "8080", key: "orch-abc", allowed: [] });

  expect(out).toContain('api_key = "orch-abc"');
  expect(out).not.toContain("your-secret-api-key");
  expect(out.match(/api_key/g)!.length).toBe(1);
});

test("the address we will call is the address the server is told to bind", () => {
  const out = patchConfig(EXAMPLE, { host: "127.0.0.1", port: "8080", key: "k", allowed: [] });

  expect(out).toContain('host = "127.0.0.1"');
  expect(out).toContain("port = 8080");
  expect(out).not.toContain("0.0.0.0");
  // An address with no port at all still produces a valid file rather than
  // `port = NaN`, which the server rejects on load.
  expect(patchConfig(EXAMPLE, { host: "localhost", key: "k", allowed: [] })).toContain("port = 8080");
});

test("the egress image is pinned past the one that 403s every scoped fetch", () => {
  // v1.1.4 403s every scoped package fetch while a credential is bound, and the
  // packaged example may ship exactly that.
  const out = patchConfig(EXAMPLE, { host: "h", port: "1", key: "k", allowed: [] });

  expect(out).toContain('image = "opensandbox/egress:v1.1.6"');
  expect(out).not.toContain("v1.1.4");
});

test("a missing storage section is added rather than dropping the allowlist on the floor", () => {
  // This is the silent one. A path missing from `allowed_host_paths` does not
  // fail the mount — it delivers an empty directory, and the only symptom is
  // every agent having no skills.
  const out = patchConfig(EXAMPLE, { host: "h", port: "1", key: "k", allowed: ["/Users/me", "/var/tmp/orch-cache"] });

  expect(out).toContain('[storage]\nallowed_host_paths = ["/Users/me", "/var/tmp/orch-cache"]');
});

/**
 * A session merges the two streams, so they are separated again by hand.
 *
 * Proven in a live container: inside a session `readlink /proc/self/fd/1` and
 * `fd/2` both answer `pipe:[5228080]` — **the same pipe inode** — while `run()`
 * gets `/tmp/<id>.stdout` and `.stderr`. So `onStderr` can never fire on the
 * session path: the SDK offers the callback and the server has nothing to feed it.
 */
/**
 * Swapping `run()` for `runInSession()` would have put git's warnings back into
 * NUL-delimited `STATUS_Z` output, which is the defect `sandboxGit` was repaired
 * for. The wrapper does what the one-shot path does — redirect each stream, read
 * the other back — verified byte-identical to `run()` on a failure, a success that
 * writes to stderr, a plain success and multi-line output.
 */
/**
 * A command that exits takes its own output with it.
 *
 * The wrapper's last line has been a subshell since a bare `exit` ended the
 * session once. The *caller's* command was still a brace group, so an `exit` in
 * it ended the session too — before the two `cat`s that read the captured
 * streams back. What the caller got was exit 0 and two empty strings, which is a
 * command that succeeded silently.
 */
/**
 * `modelAsk` sends `codex … < prompt; rc=$?; rm -f prompt; exit $rc`, so
 * PageIndex has never built on this installation: every call came back empty,
 * three of them tripped its breaker, and the panel reported an account that was
 * fine. Run against the real bash rather than asserted as a shape — the bug was
 * that the shell did something other than what the string looked like.
 */
test("a command that exits still hands back what it printed", async () => {
  const file = join(tempDir("orch-wrap-"), "e");
  const run = async (cmd: string) => {
    const p = Bun.spawn(["bash", "-c", wrapForSession(cmd, file)], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { ...unwrap(out.replace(/\n$/, "")), code };
  };

  expect(await run("echo hi")).toEqual({ out: "hi", err: "", code: 0 });
  // The shape every caller that cleans up after itself writes.
  expect(await run("echo hi; rc=$?; exit $rc")).toEqual({ out: "hi", err: "", code: 0 });
  // And a failure keeps both halves: the code, and what was said about it.
  expect(await run("echo hi; echo bad >&2; exit 3")).toEqual({ out: "hi", err: "bad", code: 3 });
});

test("the session wrapper separates the streams the way run() does", () => {
  // The marker travels as a `printf` escape, never as a shell argument: the first
  // version used NUL, which a shell argument cannot carry — it would have been
  // truncated before `printf` saw it and the marker would never have matched.
  const wrapped = wrapForSession("ls /nope", "/tmp/e");
  expect(wrapped).toContain("2>/tmp/e");
  expect(wrapped).toContain(String.raw`printf '\001orch-stderr\001'`);
  // A subshell, because a bare `exit` ends the session — which it did, once.
  expect(wrapped).toContain("( exit $__orch_rc )");

  const MARK = `${SOH}orch-stderr${SOH}`;
  expect(unwrap(`out${MARK}warn`)).toEqual({ out: "out", err: "warn" });
  expect(unwrap(`hello${MARK}`)).toEqual({ out: "hello", err: "" });
  expect(unwrap(`${MARK}only stderr`)).toEqual({ out: "", err: "only stderr" });
  // One trailing newline, because the marker arrives glued to the last line of
  // stdout rather than after it — `run()` strips one per message.
  expect(unwrap(`a\nb\n${MARK}`)).toEqual({ out: "a\nb", err: "" });
  // No marker at all is the old merged behaviour, not a lost line.
  expect(unwrap("everything")).toEqual({ out: "everything", err: "" });

  // A blank line does not survive this transport as itself — measured against the
  // running server, `printf 'a\n\n\nb\n'` arrives as `["a", "b"]` — so the
  // wrapper spells it and `unwrap` reads it back. A whole line, never a substring:
  // output that merely contains the marker keeps it.
  const BLANK = `${SOH}blank${SOH}`;
  expect(wrapped).toContain(String.raw`sed 's/^$/\x01blank\x01/'`);
  expect(wrapped).toContain("command -v sed");
  expect(unwrap(`a\n${BLANK}\n${BLANK}\nb${MARK}`)).toEqual({ out: "a\n\n\nb", err: "" });
  expect(unwrap(`x${BLANK}y${MARK}`)).toEqual({ out: `x${BLANK}y`, err: "" });
});

/**
 * A fake container, with only the four things the session path touches.
 *
 * `logs.stdout` because a session puts everything there — including stderr, which
 * is the whole reason the wrapper exists.
 */
function fakeSandbox(script: {
  createSession?: () => Promise<string>;
  runInSession?: (id: string, cmd: string) => Promise<{ exitCode: number; logs: { stdout: { text: string }[] } }>;
  run?: (
    cmd: string,
  ) => Promise<{ exitCode: number; logs: { stdout: { text: string }[]; stderr: { text: string }[] } }>;
}) {
  const seen: string[] = [];
  const sandbox = {
    id: "sb-1",
    commands: {
      createSession: async () => {
        seen.push("createSession");
        return (await script.createSession?.()) ?? "sess-1";
      },
      runInSession: async (id: string, cmd: string) => {
        seen.push(`runInSession ${cmd.slice(0, 12)}`);
        return (await script.runInSession?.(id, cmd)) ?? { exitCode: 0, logs: { stdout: [{ text: "/home/app\n" }] } };
      },
      run: async (cmd: string) => {
        seen.push("run");
        return (await script.run?.(cmd)) ?? { exitCode: 0, logs: { stdout: [{ text: "one-shot" }], stderr: [] } };
      },
    },
  };
  return { sandbox, seen };
}

/**
 * The ladder down from a session, which is what keeps this from being a risk.
 *
 * A session is 5ms against `run()`'s 1013ms, so it is the path everything takes —
 * and every way it can be unavailable has to land on the behaviour that was there
 * before. Three ways: the command needs environment, which `runInSession` cannot
 * carry; the server will not open a session; and a session that existed has died
 * with its shell or its container.
 */
test("a command with environment does not use a session", async () => {
  forgetSessions();
  const { sandbox, seen } = fakeSandbox({});
  const out = await runIn(sandbox, "echo hi", { env: { CODEX_HOME: "/x" } });
  expect(out.out).toBe("one-shot");
  // Not even asked for: `runInSession` takes `workingDirectory` and
  // `timeoutSeconds` and not `envs`, so a session could not carry it.
  expect(seen).toEqual(["run"]);
});

test("a server that will not open a session falls back to the one-shot path", async () => {
  forgetSessions();
  const { sandbox, seen } = fakeSandbox({
    createSession: () => Promise.reject(new Error("not supported")),
  });
  const out = await runIn(sandbox, "echo hi", {});
  expect(out.out).toBe("one-shot");
  expect(seen).toEqual(["createSession", "run"]);
});

test("a session that dies is rebuilt once, then given up on", async () => {
  forgetSessions();
  let opened = 0;
  const { sandbox, seen } = fakeSandbox({
    createSession: async () => `sess-${++opened}`,
    runInSession: (_id, cmd) =>
      // `pwd` is the probe that establishes the session's home; the command itself
      // is what fails, every time, so the retry is exhausted and `run()` answers.
      cmd === "pwd"
        ? Promise.resolve({ exitCode: 0, logs: { stdout: [{ text: "/home/app\n" }] } })
        : Promise.reject(new Error("session gone")),
  });
  const out = await runIn(sandbox, "echo hi", {});
  expect(out.out).toBe("one-shot");
  expect(opened).toBe(2);
  expect(seen.filter((s) => s === "createSession")).toHaveLength(2);
  expect(seen).toContain("run");
});

/**
 * Containers the server is holding that nothing here claims.
 *
 * The only reason the last batch was found is that a machine ran out of memory:
 * 48 of them against a `grp` table with no rows, each ~250 MB with a 24-hour
 * TTL, and not one word about it anywhere in the panel. `reconnect` leaking them
 * is fixed; this is the other half, because an installation that already has
 * them still had no way to know.
 */
/**
 * Read from the reply the reachability probe already makes, so the count costs
 * no extra request — and claimed means every column that can name one: a group's,
 * a project's, and the utility slot in `setting`.
 */
describe("stranded sandboxes are counted, not discovered by running out of memory", () => {
  const held = (...ids: string[]) => ids.map((id) => ({ id, owner: "project-1" }));

  test("a container no column names is reported", async () => {
    const db = await openMemory();
    const c = await strandedCheck(db, held("a", "b"));
    expect(c?.ok).toBe(false);
    expect(renderSaid("en", c!.said)).toContain("2 containers");
  });

  test("one the utility slot claims is not stranded", async () => {
    const db = await openMemory();
    await writeSetting(db, "util_sandbox_id", "a");
    expect(await strandedCheck(db, [{ id: "a", owner: "util" }])).toBeNull();
  });

  test("somebody else's container on the same server is not ours to count", async () => {
    const db = await openMemory();
    // No `owner` we set, so not from this orchestrator. Counting it would tell
    // the boss to delete a stranger's container.
    expect(await strandedCheck(db, [{ id: "x", owner: "someone-else" }])).toBeNull();
  });

  test("a server that did not answer is not evidence of anything", async () => {
    const db = await openMemory();
    expect(await strandedCheck(db, undefined)).toBeNull();
  });
});
