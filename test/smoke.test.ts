import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, type Started } from "../src/server.ts";

/**
 * Boots the real server over real HTTP and walks the boss's path as far as the
 * DRAFT gate. Spends no tokens: a DRAFT group does not dispatch, which is
 * exactly the property being asserted.
 */

let srv: Started;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "orch-smoke-"));
  // No `git init` here any more: a project is a GitHub repository, not a
  // directory on this machine, so dataDir is only ever the server's own store.
  // maxGroups 0 blocks every group turn, which is how this test exercises the
  // real HTTP server without spawning a single agent or spending a token.
  // Port 0, not a fixed one: several groups run `bun test` in their own worktrees
  // at the same time, and a fixed port means they fight over it — whoever loses
  // talks to another group's server and fails on a response that was never theirs.
  // Four groups were red at once on this, which reads as a project-wide breakage
  // and is really just this line. srv.url carries whatever the OS handed out.
  srv = start({ dataDir, port: 0, maxGroups: 0 });
});

afterAll(() => {
  srv.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (path: string, body?: unknown, token?: string) =>
  fetch(`${srv.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-orch-token": token } : {}) },
    body: JSON.stringify(body ?? {}),
  });

test("the web UI is served and fetches nothing from a remote origin", async () => {
  const r = await fetch(`${srv.url}/`);
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toContain("orchestrator");

  // Local assets are fine; a remote origin is not. Fonts are the ones already on
  // the machine, so a strict local page must never reach out.
  const remote = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);
  expect(remote.filter((u) => /^(https?:)?\/\//.test(u))).toEqual([]);
  expect(html).not.toMatch(/@import\s+url\(/);

  // The built bundle has to be there and served, or the page is a blank div and
  // every panel silently shows nothing.
  for (const asset of ["/dist/main.js", "/dist/app.css"]) {
    const a = await fetch(`${srv.url}${asset}`);
    expect(a.status).toBe(200);
    // The bundle name carries no hash, so without this the browser keeps serving
    // the previous build: a deleted button survived a rebuild and a restart.
    expect(a.headers.get("cache-control")).toBe("no-cache");
    expect((await a.text()).length).toBeGreaterThan(1000);
  }
});

test("boss path: add project, drop an idea, nothing runs without a slot", async () => {
  // Inserted rather than POSTed: registering a project is now one request to
  // api.github.com for the repository's default branch, and a smoke test that
  // reaches the network fails on a train. What it stands in for — the repo list
  // and `POST /api/projects` — is covered against an injected client in
  // test/ghlogin.test.ts. Everything after this line is still real HTTP.
  const p = srv.ctx.db
    .query<{ id: number }, []>(
      `INSERT INTO project (name, repo_path, remote, config_json, base_branch, created_at)
       VALUES ('demo', 'example/demo', 'https://github.com/example/demo.git', '{"gates":[]}', 'main', 0)
       RETURNING id`,
    )
    .get()!;
  expect(p.id).toBeGreaterThan(0);

  const idea = await (await post("/api/ideas", { project_id: p.id, text: "add rate limiting" })).json();
  expect(idea.grp_id).toBeGreaterThan(0);

  const state = await (await fetch(`${srv.url}/api/state`)).json();
  const grp = state.groups.find((g: any) => g.id === idea.grp_id);
  expect(grp.status).toBe("PLANNING");

  // The dispatcher turn is queued and stays queued: no slot, no spend.
  await Bun.sleep(50);
  const jobs = srv.ctx.db
    .query<{ state: string; kind: string }, []>("SELECT state, kind FROM job")
    .all();
  // One queued turn: the Dispatcher's planning pass. It stays pending — no slot,
  // no spend. The Librarian's onboarding pass is not here any more: it read the
  // host checkout, and a project has none until a group clones (007 §2).
  expect(jobs.length).toBe(1);
  expect(jobs.every((j) => j.kind === "agent_turn" && j.state === "pending")).toBe(true);
  expect(srv.ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM agent").get()!.c).toBe(0);

  // PLAN.md §12 asks the smoke run to assert the four first-class tables, because
  // "the request was accepted" and "the request was recorded" are different claims and
  // only the second one matters after a restart.
  const count = (t: string) =>
    srv.ctx.db.query<{ c: number }, []>(`SELECT count(*) AS c FROM ${t}`).get()!.c;
  expect(count("job")).toBe(1);
  // event: the project, the idea, the group's channel opening — the append-only half.
  expect(count("event")).toBeGreaterThanOrEqual(1);
  // note: the idea itself is a fact, plus whatever registration wrote (gates, PR
  // preflight). The idea being a note is what lets a later group find it.
  expect(count("note")).toBeGreaterThanOrEqual(1);
  const ideaNote = srv.ctx.db
    .query<{ body: string }, [number]>("SELECT body FROM note WHERE grp_id = ? AND kind = 'fact'")
    .get(idea.grp_id);
  expect(ideaNote?.body).toContain("rate limiting");
  // task: none yet, and that is the point — tasks exist only after the boss approves a
  // card, so a task here would mean work started without approval.
  expect(count("task")).toBe(0);
  expect(count("slice")).toBe(0);
});

test("a malformed DRAFT card is refused over the wire, status unchanged", async () => {
  const state = await (await fetch(`${srv.url}/api/state`)).json();
  const grp = state.groups.find((g: any) => g.status === "PLANNING");
  const r = await post(`/api/draft/${grp.id}/approve`, { card: "目标 : 只有这一行" });
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("missing sections");

  const after = await (await fetch(`${srv.url}/api/state`)).json();
  expect(after.groups.find((g: any) => g.id === grp.id).status).toBe("PLANNING");
});

test("orch verbs reject a request with no token", async () => {
  const r = await post("/orch/status", { text: "hello" });
  expect(r.status).toBe(422);
});

test("the SSE stream opens and replays the log from a cursor", async () => {
  const ac = new AbortController();
  const r = await fetch(`${srv.url}/api/stream?since=0`, { signal: ac.signal });
  expect(r.headers.get("content-type")).toContain("text/event-stream");

  const reader = r.body!.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value!);
  // Replay from a cursor is what lets a reconnecting browser catch up without
  // keeping any state of its own.
  expect(chunk).toContain("data: ");
  expect(chunk).toContain("boss_say");
  ac.abort();
});

test("state stays queryable after a reconnect", async () => {
  const s = await (await fetch(`${srv.url}/api/state`)).json();
  expect(s.lastSeq).toBeGreaterThan(0);
  expect(Array.isArray(s.channels)).toBe(true);
});

test("no build step resolves a package at gate time", () => {
  // `bunx @tailwindcss/cli` re-resolves and installs into node_modules on every
  // run. Worktrees share one node_modules by symlink, so two gates running at
  // once raced on it: `error: Failed to link jiti: EEXIST`, five times on one
  // slice, and the group read it as its own build being broken. The binaries are
  // already in `node_modules/.bin` — a dependency is a dependency.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    expect(`${name}: ${cmd}`).not.toContain("bunx");
  }
});
