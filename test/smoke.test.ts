import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  // maxGroups 0 blocks every group turn, which is how this test exercises the
  // real HTTP server without spawning a single agent or spending a token.
  srv = start({ dataDir, port: 47899, maxGroups: 0 });
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

test("the web UI is served and is self-contained", async () => {
  const r = await fetch(`${srv.url}/`);
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toContain("orchestrator");
  // No build step and no CDN: a strict local page must not fetch anything.
  expect(html).not.toMatch(/<script[^>]+src=/);
  expect(html).not.toMatch(/<link[^>]+stylesheet/);
});

test("boss path: add project, drop an idea, nothing runs without a slot", async () => {
  const p = await (await post("/api/projects", { name: "demo", repo_path: dataDir })).json();
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
  expect(jobs.length).toBe(1);
  expect(jobs[0]!.kind).toBe("agent_turn");
  expect(jobs[0]!.state).toBe("pending");
  expect(srv.ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM agent").get()!.c).toBe(0);
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
