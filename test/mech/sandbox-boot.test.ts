import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setIn } from "../../src/mech/sandbox/server.ts";
import { loadAuth, SANDBOX_KEY, saveAuth } from "../../src/mech/sandbox/auth.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import {
  adoptServerKey,
  isServerLine,
  keyInConfig,
  pidAlive,
  remoteInClear,
  SANDBOX_API_KEY_HEADER,
  sandboxScope,
  splitAddr,
  UTIL,
} from "../../src/mech/sandbox/sandbox.ts";
import { tempDir } from "../support/temp.ts";

/**
 * Starting the container server, and the four ways the first attempt lied.
 *
 * Every check here is one measured failure. The shared shape is that none of
 * them threw: a config was written that the server rejected, a key was sent in a
 * header nothing reads, and a shell was mistaken for a server — each reported as
 * "cannot connect", which was true and named none of them.
 */

// The example `opensandbox-server init-config` actually renders, trimmed to the
// parts that matter. `mode` appears in two sections and `api_key` ships
// commented out; both are load-bearing here.
const EXAMPLE = `[server]
host = "0.0.0.0"
port = 8080
# api_key = "your-secret-api-key"
# If api_key stays empty, startup requires explicit acknowledgment.

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.21"

[storage]
# Example: allowed_host_paths = ["/data/opensandbox", "/tmp/sandbox"]
volume_default_size = "1Gi"

[ingress]
mode = "direct"

[egress]
image = "opensandbox/egress:v1.1.4"
mode = "direct"
`;

test("a key is set in its own section, not in whichever section came first", () => {
  // The one that stopped the server booting. A file-wide `^mode =` replaced
  // `[ingress] mode` with `dns+nft`, and the server refused to start:
  //   Input should be 'direct' or 'gateway'
  // `mode` exists twice, and a match that does not know about sections finds
  // the wrong one every time.
  let toml = setIn(EXAMPLE, "egress", "mode", `mode = "dns+nft"`);
  toml = setIn(toml, "egress", "image", `image = "opensandbox/egress:v1.1.6"`);

  expect(toml).toContain(`[ingress]\nmode = "direct"`);
  expect(toml).toContain(`image = "opensandbox/egress:v1.1.6"`);
  expect(toml).toContain(`[egress]\nimage = "opensandbox/egress:v1.1.6"\nmode = "dns+nft"`);
  // v1.1.4 403s every scoped package fetch while a credential is bound (005),
  // and the example ships it.
  expect(toml).not.toContain("v1.1.4");
});

test("a commented-out key is the key, not a missing one", () => {
  // `# api_key = "your-secret-api-key"` read as absent left the server with no
  // key at all while we sent one — 401 on every call, reported as "the server
  // does not accept our key", which is exactly backwards.
  const toml = setIn(EXAMPLE, "server", "api_key", `api_key = "orch-abc"`);
  const f = join(tempDir("orch-toml-"), "sandbox.toml");
  writeFileSync(f, toml);
  expect(keyInConfig(f)).toBe("orch-abc");
  // Replaced in place, not appended beside the commented one. Counting
  // assignment lines, not the word: the example also mentions `api_key` in a
  // sentence, and that line is prose.
  expect(toml.split("\n").filter((l) => /^[ \t]*#?[ \t]*api_key[ \t]*=/.test(l))).toEqual([`api_key = "orch-abc"`]);
});

test("a key with no line anywhere is added, and a missing section is created", () => {
  // `allowed_host_paths` is only ever present as a comment in the example, and
  // it is the silent one: a path missing from it does not fail, it mounts an
  // empty directory, and every agent quietly has no skills.
  const toml = setIn(EXAMPLE, "storage", "allowed_host_paths", `allowed_host_paths = ["/a", "/b"]`);
  expect(toml).toContain(`[storage]\nallowed_host_paths = ["/a", "/b"]`);
  // Untouched neighbours stay in their own section.
  expect(toml).toContain(`volume_default_size = "1Gi"`);

  const made = setIn(EXAMPLE, "nowhere", "k", `k = 1`);
  expect(made).toContain(`[nowhere]\nk = 1`);
});

test("the key travels in the one header the server reads", () => {
  // `Authorization: Bearer` is indistinguishable from a wrong key — 401 either
  // way — and the message then says the key was rejected when it was never
  // presented. The server reads this header and nothing else
  // (`middleware/auth.py`), so it has one home and both probes import it.
  expect(SANDBOX_API_KEY_HEADER).toBe("OPEN-SANDBOX-API-KEY");
  const src = ["src/mech/sandbox/server.ts", "src/mech/ops/preflight.ts"];
  for (const f of src) {
    const text = readFileSync(f, "utf8");
    // Nobody re-spells it, and nobody reaches for Bearer against this server.
    expect(text).not.toMatch(/"OPEN-SANDBOX-API-KEY"/);
    expect(text).toContain("SANDBOX_API_KEY_HEADER");
  }
});

test("a process talking about the server is not the server", () => {
  // The one that made autostart never fire. `runningServer` matched any command
  // line containing the name, so one `pkill -f opensandbox-server` in a shell —
  // ours, during this very debugging — was read as a live server, and the caller
  // reported "already running" on a machine with none.
  //
  // Worse than a false negative: the port was free, nothing was started, and the
  // panel said it was up.
  for (const real of [
    "12345 /opt/homebrew/bin/uv tool uvx opensandbox-server --config /Users/x/.orch-cache/sandbox.toml",
    "999 /usr/local/bin/opensandbox-server",
    "42 opensandbox-server --config ./sandbox.toml",
  ]) {
    expect({ line: real.slice(0, 40), server: isServerLine(real) }).toEqual({
      line: real.slice(0, 40),
      server: true,
    });
  }

  for (const impostor of [
    "6774 /bin/zsh -c pkill -f opensandbox-server; sleep 3",
    "6780 grep opensandbox-server",
    "77 ps -Ao pid=,args=",
    "88 tail -f /tmp/opensandbox-server.log",
    "99 vim src/mech/sandbox/server.ts opensandbox-server",
    "100 echo starting opensandbox-server",
  ]) {
    expect({ line: impostor.slice(0, 40), server: isServerLine(impostor) }).toEqual({
      line: impostor.slice(0, 40),
      server: false,
    });
  }

  // And the whole point of the fix above it: `ps` is never allowed to be the
  // reason we skip starting one. The port is the fact.
  const src = readFileSync("src/mech/sandbox/server.ts", "utf8");
  const down = src.slice(src.indexOf("// Nothing answers."), src.indexOf("export async function ensureServer"));
  expect(down).toContain('kind: "down"');
});

test("the sandbox server may live on another machine, and says when that is in the clear", () => {
  // It does not have to be local: a Tailscale peer or a cloud box works, because
  // the SDK only ever speaks HTTP to it. What changes with distance is whether
  // the transport protects the api_key.
  expect(splitAddr("127.0.0.1:8080")).toEqual({ protocol: "http", authority: "127.0.0.1:8080" });
  expect(splitAddr("https://sb.example.com:8080")).toEqual({
    protocol: "https",
    authority: "sb.example.com:8080",
  });
  // A trailing slash is what a pasted URL has, and it must not become part of
  // the authority — `host:8080/` resolves to nothing.
  expect(splitAddr("http://sb.example.com:8080/").authority).toBe("sb.example.com:8080");

  // Safe: loopback, or a network that encrypts itself. Tailscale hands out
  // 100.64.0.0/10 and *.ts.net, and that transport is WireGuard — which is the
  // whole reason plain HTTP to a peer is not a mistake.
  for (const ok of [
    "127.0.0.1:8080",
    "127.1.2.3:8080",
    "[::1]:8080",
    "localhost:8080",
    "dev.localhost:8080",
    "LOCALHOST:8080",
    "100.64.0.1:8080",
    "100.101.102.103:8080",
    "100.127.255.254:8080",
    "box.tail1234.ts.net:8080",
    "https://sb.example.com:8080",
  ]) {
    expect({ addr: ok, inClear: remoteInClear(ok) }).toEqual({ addr: ok, inClear: false });
  }

  // Not safe, and reported rather than blocked: it may be a private VLAN this
  // side cannot see, and refusing outright would be deciding something we do not
  // know. 100.128.x is deliberately outside the CGNAT range Tailscale uses.
  for (const bad of [
    "sb.example.com:8080",
    "http://203.0.113.10:8080",
    "100.63.255.255:8080",
    "100.128.0.1:8080",
    "10.0.0.1:8080",
    "notlocalhost:8080",
    "ts.net.evil.com:8080",
    // A bare IPv6 literal is not a valid authority — it cannot be told from a
    // host with a port — so it is unparseable rather than loopback.
    "::1",
  ]) {
    expect({ addr: bad, inClear: remoteInClear(bad) }).toEqual({ addr: bad, inClear: true });
  }
});

test("a sandbox span is scoped to what owns the container, and the utility one to nothing", () => {
  // `sandbox.create` and `sandbox.init` are the two stages a boss most often
  // loses minutes to, so their rows have to be aggregable by group. The utility
  // container holds the real credentials and belongs to no project: NULL is the
  // answer there, not project zero.
  expect(sandboxScope({ grp: 4 }, 9)).toEqual({ "grp.id": 4, "project.id": 9 });
  expect(sandboxScope({ project: 9 }, 9)).toEqual({ "project.id": 9 });
  expect(sandboxScope(UTIL, null)).toEqual({});
});

/**
 * A pid is alive when it exists, whoever owns it.
 *
 * `ps` is 30.6ms and this is 253ns, so the watchdog's steady state asks this and
 * forks only when the answer is no. What it must never do is answer "gone" for a
 * process that is there — that is the input to a decision whose failure mode is
 * restarting a server that is already running.
 */
describe("a pid is alive when it exists, whoever owns it", () => {
  test.each([
    ["our own process", String(process.pid), true],
    // init exists and is not ours: `kill` fails with EPERM, which is a yes.
    ["init, which is not ours", "1", true],
    // Above any pid this machine will hand out.
    ["above any pid this machine hands out", "999999", false],
  ])("%s", (_case, pid, alive) => {
    expect(pidAlive(pid)).toBe(alive);
  });
  // Not a pid at all. `process.kill` throws on these too, and a throw must not
  // be read as "alive" the way EPERM is.
  for (const junk of ["nope", "-1", "0", "", "1.5", "1e9"]) {
    expect({ junk, alive: pidAlive(junk) }).toEqual({ junk, alive: false });
  }
});

/**
 * The key we wrote, taken back when the database no longer has it.
 *
 * `ourKey` stores it in `runtime_auth`; `writeConfig` puts it in
 * `~/.orch-cache/sandbox.toml` and never rewrites that file. Only one of the two
 * homes is rebuilt with the database, so a fresh schema against a server still
 * running left the key on disk, nothing in the row, and no header on any probe.
 */
/**
 * Measured on a real machine: `opensandbox-server --config
 * ~/.orch-cache/sandbox.toml` alive since a previous boot, no `sandbox` row, and
 * the panel reporting "something is listening that we did not start". It was our
 * own server, holding our own key.
 */
/**
 * And it could not recover on its own: `startPlan` refuses to spawn into a taken
 * port, so `ourKey` and `writeConfig` are never reached again. Every container
 * operation goes through this server, so what the boss sees is that Claude and
 * Codex cannot be signed in.
 */
describe("the sandbox key has two homes and only one is rebuilt", () => {
  const onDisk = (key: string): string => {
    const f = join(tempDir("orch-adopt-"), "sandbox.toml");
    writeFileSync(f, `[server]\nhost = "127.0.0.1"\nport = 8080\napi_key = "${key}"\n`);
    return f;
  };
  // `serverKeyOnDisk` reads `$OPENSANDBOX_CONFIG` first, which is what lets this
  // name a file instead of needing a server running on the machine.
  const withConfig = async <T>(path: string | null, run: () => Promise<T>): Promise<T> => {
    const had = process.env.OPENSANDBOX_CONFIG;
    if (path) process.env.OPENSANDBOX_CONFIG = path;
    else delete process.env.OPENSANDBOX_CONFIG;
    try {
      return await run();
    } finally {
      if (had === undefined) delete process.env.OPENSANDBOX_CONFIG;
      else process.env.OPENSANDBOX_CONFIG = had;
    }
  };

  test("an empty database takes the key back from the server's own config", async () => {
    const db = await openMemory();
    const took = await withConfig(onDisk("orch-fromdisk"), () => adoptServerKey(db));
    expect(took).toBe(true);
    const stored = await loadAuth(db, SANDBOX_KEY);
    expect(stored?.secret).toBe("orch-fromdisk");
    // Bound to the address in the same file, never to `sandbox.server`: that is
    // the whole reason a key read off disk is safe to store without asking.
    expect(stored?.baseUrl).toBe("http://127.0.0.1:8080");
  });

  test("a key already stored is somebody's choice and is left alone", async () => {
    const db = await openMemory();
    await saveAuth(db, {
      runtime: SANDBOX_KEY,
      mode: "api_key",
      secret: "typed-by-hand",
      baseUrl: "http://127.0.0.1:8080",
    });
    const took = await withConfig(onDisk("orch-fromdisk"), () => adoptServerKey(db));
    expect(took).toBe(false);
    expect((await loadAuth(db, SANDBOX_KEY))?.secret).toBe("typed-by-hand");
  });

  test("a config path that does not exist is a no-op, not a throw", async () => {
    const db = await openMemory();
    // No assertion on the return value, and that is the finding rather than a
    // gap: `configPaths` ends at `runningServer()?.config`, so on a machine with
    // a sandbox server actually running there is no way to stage "nothing on
    // disk" — this test wrote `$OPENSANDBOX_CONFIG` at a file that does not
    // exist and still adopted a key, out of the live server's own `--config`.
    // Which is the mechanism working. What is asserted here is the other half:
    // an unreadable path is `keyInConfig` returning null, never an exception on
    // the boot path.
    await withConfig(join(tempDir("orch-adopt-"), "absent.toml"), () => adoptServerKey(db));
  });
});
