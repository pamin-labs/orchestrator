import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, type Started } from "../src/server.ts";

/**
 * Boots the real server over real HTTP and walks the boss's path as far as the
 * DRAFT gate. Spends no tokens: a DRAFT group does not dispatch, which is
 * exactly the property being asserted.
 */

const ASSET_MAIN_JS = "/dist/main.js";
const ASSET_APP_CSS = "/dist/app.css";
const ENDPOINT_PROJECTS = "/api/projects";
const ENDPOINT_IDEAS = "/api/ideas";
const ENDPOINT_STATE = "/api/state";
const ENDPOINT_ORCH_STATUS = "/orch/status";

let srv: Started;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "orch-smoke-"));
  // The smoke run registers dataDir as a project, and registration wants a repo
  // with a GitHub `origin` — a PR is where the work ends up, so a project without
  // one is refused rather than discovered at delivery time.
  Bun.spawnSync(["git", "init", "-q", "-b", "main", dataDir]);
  Bun.spawnSync(["git", "-C", dataDir, "remote", "add", "origin", "git@github.com:example/demo.git"]);
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
  for (const asset of [ASSET_MAIN_JS, ASSET_APP_CSS]) {
    const a = await fetch(`${srv.url}${asset}`);
    expect(a.status).toBe(200);
    // The bundle name carries no hash, so without this the browser keeps serving
    // the previous build: a deleted button survived a rebuild and a restart.
    expect(a.headers.get("cache-control")).toBe("no-cache");
    expect((await a.text()).length).toBeGreaterThan(1000);
  }
});

test("boss path: add project, drop an idea, nothing runs without a slot", async () => {
  const p = await (await post(ENDPOINT_PROJECTS, { name: "demo", repo_path: dataDir })).json();
  expect(p.id).toBeGreaterThan(0);

  const idea = await (await post(ENDPOINT_IDEAS, { project_id: p.id, text: "add rate limiting" })).json();
  expect(idea.grp_id).toBeGreaterThan(0);

  const state = await (await fetch(`${srv.url}${ENDPOINT_STATE}`)).json();
  const grp = state.groups.find((g: any) => g.id === idea.grp_id);
  expect(grp.status).toBe("PLANNING");

  // The dispatcher turn is queued and stays queued: no slot, no spend.
  await Bun.sleep(50);
  const jobs = srv.ctx.db
    .query<{ state: string; kind: string }, []>("SELECT state, kind FROM job")
    .all();
  // Two queued turns: the Librarian's onboarding pass from registration, and the
  // Dispatcher's planning pass. Both stay pending — no slot, no spend.
  expect(jobs.length).toBe(2);
  expect(jobs.every((j) => j.kind === "agent_turn" && j.state === "pending")).toBe(true);
  expect(srv.ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM agent").get()!.c).toBe(0);

  // PLAN.md §12 asks the smoke run to assert the four first-class tables, because
  // "the request was accepted" and "the request was recorded" are different claims and
  // only the second one matters after a restart.
  const count = (t: string) =>
    srv.ctx.db.query<{ c: number }, []>(`SELECT count(*) AS c FROM ${t}`).get()!.c;
  expect(count("job")).toBe(2);
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
  const state = await (await fetch(`${srv.url}${ENDPOINT_STATE}`)).json();
  const grp = state.groups.find((g: any) => g.status === "PLANNING");
  const r = await post(`/api/draft/${grp.id}/approve`, { card: "目标 : 只有这一行" });
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("missing sections");

  const after = await (await fetch(`${srv.url}${ENDPOINT_STATE}`)).json();
  expect(after.groups.find((g: any) => g.id === grp.id).status).toBe("PLANNING");
});

test("orch verbs reject a request with no token", async () => {
  const r = await post(ENDPOINT_ORCH_STATUS, { text: "hello" });
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
