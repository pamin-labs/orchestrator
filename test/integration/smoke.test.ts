import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { and, count, eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { start, type Started } from "../../src/composition/server.ts";
import { SnapshotSchema } from "../../src/contracts/panel.ts";
import { z } from "zod";
import type { Json } from "../../src/contracts/json.ts";
import { agent, event, job, note, slice, task } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { tempDir } from "../support/temp.ts";

const PackageJson = z.object({ scripts: z.record(z.string(), z.string()) });

/**
 * Boots the real server over real HTTP and walks the boss's path as far as the
 * DRAFT gate. Spends no tokens: a DRAFT group does not dispatch, which is
 * exactly the property being asserted.
 */

let srv: Started;
let dataDir: string;

/** The four first-class tables are counted by name below; this is the only reason. */
const rowsIn = async (table: PgTable) => (await srv.ctx.db.select({ c: count() }).from(table))[0]?.c;

function canListen(): boolean {
  try {
    // `using`, because the previous line was `void probe.stop(true)` — a dangling
    // promise, which this repository forbids, and one holding a listening socket:
    // if the close lost its race the port was still bound when the real server
    // asked for one. Bun's `Server` implements `Symbol.dispose` itself, so the
    // socket closes when this scope leaves, including down the `catch`.
    using probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    return (probe.port ?? 0) > 0;
  } catch {
    return false;
  }
}

// Official conditional suite: an HTTP smoke test needs a listening socket.
// Restricted agent sandboxes cannot provide one; CI and normal hosts still run it.
describe.skipIf(!canListen())("HTTP smoke", () => {
  beforeAll(async () => {
    dataDir = tempDir("orch-smoke-");
    // No `git init` here any more: a project is a GitHub repository, not a
    // directory on this machine, so dataDir is only ever the server's own store.
    // maxGroups 0 blocks every group turn, which is how this test exercises the
    // real HTTP server without spawning a single agent or spending a token.
    // Port 0, not a fixed one: several groups run `bun test` in their own worktrees
    // at the same time, and a fixed port means they fight over it — whoever loses
    // talks to another group's server and fails on a response that was never theirs.
    // Four groups were red at once on this, which reads as a project-wide breakage
    // and is really just this line. srv.url carries whatever the OS handed out.
    // The suite's own database, handed in: `start()` would otherwise need a
    // connection string and a server, and skipping when it has neither is a
    // green tick over the only test that boots the real process.
    srv = await start({ dataDir, port: 0, maxGroups: 0 }, await openMemory());
  });

  afterAll(async () => {
    expect(await srv.shutdown(5_000)).toBe(0);
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = (path: string, body?: Json, token?: string) =>
    fetch(`${srv.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        ...(token ? { "x-orch-token": token } : {}),
      },
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
    //
    // Named rather than left as a bare 404: this went red the first time CI ran,
    // because `bun test` came before `bun run build:web` and the failure said only
    // "expected 200, received 404" — which reads as a routing bug in the server
    // rather than as an artefact nobody built yet.
    for (const asset of ["/dist/main.js", "/dist/app.css"]) {
      const a = await fetch(`${srv.url}${asset}`);
      expect({ asset, status: a.status, hint: a.status === 200 ? "" : "run `bun run build:web` first" }).toEqual({
        asset,
        status: 200,
        hint: "",
      });
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
    // and `POST /api/v1/projects` — is covered against an injected client in
    // test/ghlogin.test.ts. Everything after this line is still real HTTP.
    const p = await fx.project.create(
      {
        name: "demo",
        repo_path: "example/demo",
        remote: "https://github.com/example/demo.git",
        config_json: { gates: [] },
        base_branch: "main",
      },
      { transient: { db: srv.ctx.db } },
    );
    expect(p.id).toBeGreaterThan(0);

    const idea = z
      .object({ grp_id: z.number() })
      .parse(await (await post("/api/v1/ideas", { project_id: p.id, text: "add rate limiting" })).json());
    expect(idea.grp_id).toBeGreaterThan(0);

    const state = SnapshotSchema.parse(await (await fetch(`${srv.url}/api/v1/state`)).json());
    const grp = state.groups.find((group) => group.id === idea.grp_id);
    if (!grp) throw new Error(`group ${idea.grp_id} missing from snapshot`);
    expect(grp.status).toBe("PLANNING");

    // The dispatcher turn is queued and stays queued: no slot, no spend.
    await Bun.sleep(50);
    const jobs = await srv.ctx.db.select({ state: job.state, kind: job.kind }).from(job);
    // One queued turn: the Dispatcher's planning pass. It stays pending — no slot,
    // no spend. The Librarian's onboarding pass is not here any more: it read the
    // host checkout, and a project has none until a group clones (007 §2).
    expect(jobs.length).toBe(1);
    expect(jobs.filter((j) => j.kind !== "agent_turn" || j.state !== "pending")).toEqual([]);
    expect(await rowsIn(agent)).toBe(0);

    // docs/project/plan.md §12 asks the smoke run to assert the four first-class tables, because
    // "the request was accepted" and "the request was recorded" are different claims and
    // only the second one matters after a restart.
    expect(await rowsIn(job)).toBe(1);
    // event: the project, the idea, the group's channel opening — the append-only half.
    expect(await rowsIn(event)).toBeGreaterThanOrEqual(1);
    // note: the idea itself is a fact, plus whatever registration wrote (gates, PR
    // preflight). The idea being a note is what lets a later group find it.
    expect(await rowsIn(note)).toBeGreaterThanOrEqual(1);
    const [ideaNote] = await srv.ctx.db
      .select({ body: note.body })
      .from(note)
      .where(and(eq(note.grp_id, idea.grp_id), eq(note.kind, "fact")));
    expect(ideaNote?.body).toContain("rate limiting");
    // task: none yet, and that is the point — tasks exist only after the boss approves a
    // card, so a task here would mean work started without approval.
    expect(await rowsIn(task)).toBe(0);
    expect(await rowsIn(slice)).toBe(0);
  });

  test("a malformed DRAFT card is refused over the wire, status unchanged", async () => {
    const state = SnapshotSchema.parse(await (await fetch(`${srv.url}/api/v1/state`)).json());
    const grp = state.groups.find((group) => group.status === "PLANNING");
    if (!grp) throw new Error("planning group missing from snapshot");
    const r = await post(`/api/v1/draft/${grp.id}/approve`, { card: "目标 : 只有这一行" });
    expect(r.status).toBe(422);
    expect(await r.text()).toContain("missing sections");

    const after = SnapshotSchema.parse(await (await fetch(`${srv.url}/api/v1/state`)).json());
    expect(after.groups.find((group) => group.id === grp.id)?.status).toBe("PLANNING");
  });

  test("orch verbs reject a request with no token", async () => {
    const r = await post("/orch/v1/status", { text: "hello" });
    expect(r.status).toBe(401);
  });

  test("the SSE stream opens and replays the log from a cursor", async () => {
    const ac = new AbortController();
    const r = await fetch(`${srv.url}/api/v1/stream?since=0`, { signal: ac.signal });
    expect(r.headers.get("content-type")).toContain("text/event-stream");

    // Read until the replay arrives rather than assuming the first chunk holds
    // it: the connect frame is written immediately and the replay is a query, so
    // they stopped sharing a chunk the moment the database left this process.
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 5_000;
    let seen = "";
    while (!seen.includes("boss_say") && Date.now() < deadline) {
      const next = await reader.read();
      if (next.done) break;
      seen += decoder.decode(next.value);
    }
    // Replay from a cursor is what lets a reconnecting browser catch up without
    // keeping any state of its own.
    expect(seen).toContain("data: ");
    expect(seen).toContain("boss_say");
    ac.abort();
  });

  test("state stays queryable after a reconnect", async () => {
    const s = SnapshotSchema.parse(await (await fetch(`${srv.url}/api/v1/state`)).json());
    expect(s.lastSeq).toBeGreaterThan(0);
    expect(Array.isArray(s.channels)).toBe(true);
  });

  test("no build step resolves a package at gate time", () => {
    // `bunx @tailwindcss/cli` re-resolves and installs into node_modules on every
    // run. Worktrees share one node_modules by symlink, so two gates running at
    // once raced on it: `error: Failed to link jiti: EEXIST`, five times on one
    // slice, and the group read it as its own build being broken. The binaries are
    // already in `node_modules/.bin` — a dependency is a dependency.
    const pkg = PackageJson.parse(JSON.parse(readFileSync("package.json", "utf8")));
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(`${name}: ${cmd}`).not.toContain("bunx");
    }
  });
});
