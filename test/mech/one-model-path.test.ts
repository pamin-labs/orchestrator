import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { summarise, skeleton } from "../../src/mech/knowledge/pageindex.ts";
import { hostClaudeHome, hostCodexHome } from "../../src/mech/sandbox/auth.ts";
import { REFRESH_HOME, seedHome } from "../../src/mech/sandbox/chatgpt.ts";

/**
 * One way to call a model, and it is inside a sandbox.
 *
 * `modelAsk` used to be a host `Bun.spawn` of `claude -p` / `codex exec`, which
 * meant the index ran on **the boss's own CLI login** rather than on the
 * credential stored in the settings page — a second credential path nothing in
 * the panel could see, and one a self-hosted `baseUrl` never reached.
 */

const SRC = new URL("../../src/", import.meta.url).pathname;

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("nothing on the host spawns a model CLI, except login and the one refresher", () => {
  // Both exceptions are deliberate and documented where they live: `login.ts`
  // runs the interactive OAuth the boss started, and `chatgpt.ts` is the single
  // host-side refresher codex's own CI guidance asks for.
  const allowed = new Set(["mech/sandbox/login.ts", "mech/sandbox/chatgpt.ts"]);
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = file.slice(SRC.length);
    if (allowed.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    // `Bun.spawn(["claude"…` / `["codex"…` in any spelling that reaches a model.
    if (/Bun\.spawn(Sync)?\(\s*\[?\s*["'`](claude|codex)["'`]/.test(src)) offenders.push(rel);
  }
  expect(offenders).toEqual([]);
});

test("a model that answers nothing is retried, not cached as an empty summary", async () => {
  // The signature used to be stamped *before* the call and kept whatever came
  // back — `""` included — so that a broken model could not be retried forever.
  // On a machine where the ask could not work at all that wrote an empty summary
  // and a matching signature for every node: the next pass matched, skipped, and
  // the index stayed empty while reporting itself built. Nothing anywhere would
  // have said so.
  openMemory();
  let calls = 0;
  const silent = async () => {
    calls++;
    return "";
  };
  const read = () => "a file head";

  const first = await summarise(skeleton(["src/a.ts"]), read, silent);
  expect(first.calls).toBeGreaterThan(0);
  expect(first.failed).toBe(first.calls);

  const before = calls;
  const second = await summarise(skeleton(["src/a.ts"]), read, silent, { previous: first.tree });
  expect(calls).toBeGreaterThan(before);
  expect(second.failed).toBe(second.calls);
});

test("an answer is still cached, so a quiet repo costs nothing", async () => {
  let calls = 0;
  const ask = async () => {
    calls++;
    return "it holds the thing";
  };
  const read = () => "a file head";
  const first = await summarise(skeleton(["src/a.ts"]), read, ask);
  expect(first.failed).toBe(0);
  const before = calls;
  await summarise(skeleton(["src/a.ts"]), read, ask, { previous: first.tree });
  expect(calls).toBe(before);
});

test("nothing reads a host CLI session", () => {
  // The last one was the usage poller: it read the macOS keychain entry
  // `Claude Code-credentials`, falling back to `~/.claude/.credentials.json` —
  // the *host's* own login, while the check three lines above it gated on the
  // settings-page credential. Two accounts, one label. It was also the only
  // platform-specific read in the tree: keychain on macOS, a file on Linux,
  // nothing at all on Windows.
  // Code lines only. A comment saying what was removed and why is the record of
  // the incident — matching it would make the test demand its own explanation be
  // deleted, which is how a rule loses the reason it exists.
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    if (/find-generic-password|\.claude\/\.credentials\.json|claudeAiOauth/.test(code)) {
      offenders.push(file.slice(SRC.length));
    }
  }
  expect(offenders).toEqual([]);
});

test("host CLI state is found where the CLI keeps it, not where we guessed", () => {
  // Both tools relocate with an environment variable. Hardcoding `~/.codex` and
  // `~/.claude` failed silently for anyone who had set one: `codex login`
  // succeeded and the read came back empty ("finished but produced no
  // credential"), and every ticked skill staged zero files.
  const home = "/home/someone";
  expect(hostCodexHome(home)).toBe("/home/someone/.codex");
  expect(hostClaudeHome(home)).toBe("/home/someone/.claude");

  const prevCodex = process.env.CODEX_HOME;
  const prevClaude = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CODEX_HOME = "/opt/codex";
    process.env.CLAUDE_CONFIG_DIR = "/opt/claude";
    expect(hostCodexHome(home)).toBe("/opt/codex");
    expect(hostClaudeHome(home)).toBe("/opt/claude");
  } finally {
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  }
});

test("seeding the refresher's home removes what is there before writing", async () => {
  // Found on a real machine: `<dataDir>/codex-home/auth.json` linked to
  // `~/.codex/auth.json`. `Bun.write` follows a link, so the weekly refresh would
  // have overwritten and then re-refreshed the boss's own personal login — the
  // two-writers-one-token case codex's CI guidance warns about, through the back
  // door.
  //
  // The home is inside the utility container now (007 step 7), where the boss's
  // own `~/.codex` is out of reach by construction. The guarantee stays anyway,
  // as an unlink before every write: it costs one exec, and it is the ordering
  // that was bought with the incident.
  const calls: string[] = [];
  const files = new Map<string, string>();
  const io = {
    read: async (p: string) => files.get(p) ?? null,
    write: async (p: string, d: string) => {
      calls.push(`write ${p}`);
      files.set(p, d);
    },
    remove: async (p: string) => {
      calls.push(`remove ${p}`);
      files.delete(p);
    },
    run: async () => true,
  };

  await seedHome(io, '{"tokens":{"refresh_token":"ours"}}');

  expect(calls[0]).toBe(`remove ${REFRESH_HOME}/auth.json`);
  expect(calls.indexOf(`remove ${REFRESH_HOME}/auth.json`)).toBeLessThan(
    calls.indexOf(`write ${REFRESH_HOME}/auth.json`),
  );
  expect(files.get(`${REFRESH_HOME}/auth.json`)).toContain("ours");
  // Without this codex reads the OS keychain instead of the file we just wrote.
  expect(files.get(`${REFRESH_HOME}/config.toml`)).toContain("cli_auth_credentials_store");
});
