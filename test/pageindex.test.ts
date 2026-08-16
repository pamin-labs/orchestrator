import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { openMemory } from "../src/db.ts";
import { chargeIndex, loadTree, readClaude, readCodex, noteLeaves, render, saveTree, search, skeleton, summarise, type Ask } from "../src/mech/knowledge/pageindex.ts";
import { Bus } from "../src/bus.ts";
import { costReport } from "../src/mech/ops/cost.ts";
import type { Ctx } from "../src/api.ts";

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "orch-pi-"));
  mkdirSync(join(d, "src/mech"), { recursive: true });
  writeFileSync(join(d, "src/mech/notify.ts"), "export function push(){} // desktop notifications\n");
  writeFileSync(join(d, "src/mech/gate.ts"), "export function runGates(){} // deterministic checks\n");
  return d;
}
/**
 * The corpus used to come off the host's checkout (`fileRead`), which went with
 * it at 007 step 6 — the server reads heads out of the project's container in
 * one exec now. These tests are about the tree and the summarising, so they keep
 * a directory and read it here.
 */
const dirRead = (dir: string) => (id: string) => {
  try {
    return readFileSync(join(dir, id), "utf8");
  } catch {
    return null;
  }
};

const FILES = ["src/mech/notify.ts", "src/mech/gate.ts"];

test("the tree is structure first, and every node gets one summary", async () => {
  const dir = repo();
  const asks: string[] = [];
  const ask: Ask = async (p) => {
    asks.push(p);
    return p.includes("notify") ? "sends notifications to the boss" : "one line";
  };
  const { tree, calls } = await summarise(skeleton(FILES), dirRead(dir), ask);

  expect(Object.keys(tree).sort()).toEqual(["/", "src/", "src/mech/", "src/mech/gate.ts", "src/mech/notify.ts"]);
  expect(tree["src/mech/notify.ts"]!.summary).toBe("sends notifications to the boss");
  // Directories are summarised from their children, so a directory describes what
  // is under it — which is what the search step navigates on.
  expect(asks.some((p) => p.includes("src/mech/") && p.includes("notify.ts:"))).toBe(true);
  // 2 files + src/ + src/mech/. The root is not summarised: search never shows it.
  expect(calls).toBe(4);
});

test("nothing changed, nothing re-summarised", async () => {
  const dir = repo();
  const ask: Ask = async () => "a summary";
  const first = await summarise(skeleton(FILES), dirRead(dir), ask);
  const again = await summarise(skeleton(FILES), dirRead(dir), ask, { previous: first.tree });
  expect(again.calls).toBe(0);
  expect(again.tree["src/mech/gate.ts"]!.summary).toBe("a summary");
});

test("retrieval is the model walking the tree, not a similarity score", async () => {
  const dir = repo();
  const { tree } = await summarise(skeleton(FILES), dirRead(dir), async (p) =>
    p.startsWith("One line, under 20 words: what is src/mech/notify.ts")
      ? "the only place that talks to the OS notification centre"
      : "misc",
  );

  const seen: string[] = [];
  const ask: Ask = async (p) => {
    seen.push(p);
    // Answers by reading summaries, exactly as the real navigator does. The
    // question shares no words with the file name it should land on.
    // Picks the menu line whose summary mentions notifications; falls back to the
    // first entry. No word of the question appears in any id.
    const lines = (p.split("NONE if none of them are relevant.")[1] ?? "").trim().split("\n");
    const hit = lines.find((l) => l.includes("notification centre")) ?? lines[0]!;
    return hit.split(" — ")[0]!;
  };
  const hits = await search(tree, "where does the desktop popup come from", ask);
  expect(hits).toEqual(["src/mech/notify.ts"]);
  expect(seen[0]).toContain("Which of these are worth opening");
  expect(render(tree, hits)).toContain("notification centre");
});

test("a navigator that finds nothing relevant says so instead of guessing", async () => {
  const dir = repo();
  const { tree } = await summarise(skeleton(FILES), dirRead(dir), async () => "s");
  expect(await search(tree, "how do I file my taxes", async () => "NONE")).toEqual([]);
});

test("the tree survives a round trip through the note it lives in", async () => {
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  const { tree } = await summarise(skeleton(FILES), dirRead(repo()), async () => "s");
  saveTree(db, 1, tree);
  saveTree(db, 1, tree);
  expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM note WHERE kind = 'pageindex'").get()!.c).toBe(1);
  expect(loadTree(db, 1)!["src/mech/gate.ts"]!.summary).toBe("s");
});

test("journals and retros are leaves in the same tree as the code", async () => {
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run(
    "INSERT INTO note (grp_id, kind, body, at) VALUES (1, 'retro', 'the flicker was the key, not the diffing', 0)",
  );

  const notes = noteLeaves(db, 1);
  expect(notes.ids).toEqual(["notes/grp-1/retro/1"]);

  const { tree } = await summarise(skeleton(notes.ids), notes.read, async (p) =>
    p.includes("what does this note establish") ? "why the timeline flickered" : "the group's retros",
  );
  // The note prompt is the one that ran: a retro is not a source file and asking
  // "what is this file for" of one produces a summary of the format.
  expect(tree["notes/grp-1/retro/1"]!.summary).toBe("why the timeline flickered");

  const hits = await search(tree, "did anyone work out the flicker", async (p) => {
    const lines = (p.split("NONE if none of them are relevant.")[1] ?? "").trim().split("\n");
    return lines[0]!.split(" — ")[0]!;
  });
  expect(hits).toEqual(["notes/grp-1/retro/1"]);
});

test("what the index spends shows up in the cost report", async () => {
  // The most frequent model call in the system appeared in no report at all: it
  // is not a turn, and `costReport` reads turns. It is charged to a standing
  // `indexer` row rather than to the Librarian, whose turns carry a full cached
  // prefix and a session — mixing the two makes "librarian took 4M" unusable.
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  const ctx = { db, bus: new Bus(db) } as unknown as Ctx;
  const spec = { runtime: "codex", model: "gpt-5.6-luna" };

  chargeIndex(ctx, 1, spec, { input: 100, output: 20, cacheRead: 5, cacheCreate: 1, thinking: 0 });
  chargeIndex(ctx, 1, spec, { input: 10, output: 2, cacheRead: 0, cacheCreate: 0, thinking: 0 });

  const report = costReport(db);
  expect(report.byRole.find((r) => r.label === "indexer")?.tokens).toBe(138);
  expect(report.byRuntime.find((r) => r.label === "codex")?.tokens).toBe(138);
  // One row per project, not one per call.
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM agent WHERE role = 'indexer'").get()!.n).toBe(1);
  // And the hourly burn chart reads the events, which need the same meta shape a
  // turn emits or the provider split guesses from the model name.
  const ev = db
    .query<{ meta_json: string }, []>("SELECT meta_json FROM event WHERE author = 'indexer' LIMIT 1")
    .get()!;
  expect(JSON.parse(ev.meta_json).runtime).toBe("codex");
});

test("a call that reported no usage is not charged", () => {
  // Missing numbers must never fail the index, and a zero row would be a lie in
  // the report rather than an absence.
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  const ctx = { db, bus: new Bus(db) } as unknown as Ctx;
  chargeIndex(ctx, 1, { runtime: "codex", model: "m" }, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 });
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM agent").get()!.n).toBe(0);
});

test("an index call is billed for its cached tokens once, not twice", () => {
  // The indexer is the most frequent model call in the system and it defaults to
  // codex, whose `input_tokens` already contains the cached part — the opposite
  // of claude. Reading both with one key-name-parameterised helper kept the pair
  // of key names, which is the part that differs, and dropped the subtraction,
  // which is the part that matters. A real 10k call with 8k cached was billed
  // 18050 instead of 10050, and that number reaches the boss's burn chart.
  const codex = readCodex(
    [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "auth middleware" } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10_000, cached_input_tokens: 8_000, output_tokens: 50 },
      }),
    ].join("\n"),
  );
  expect(codex.text).toBe("auth middleware");
  expect(codex.usage).toEqual({ input: 2_000, output: 50, cacheRead: 8_000, cacheCreate: 0, thinking: 0 });

  // claude's own input_tokens excludes the cache, so nothing comes off there.
  const claude = readClaude(
    JSON.stringify({
      result: "auth middleware",
      usage: { input_tokens: 2_000, cache_read_input_tokens: 8_000, output_tokens: 50 },
    }),
  );
  expect(claude.usage).toEqual({ input: 2_000, output: 50, cacheRead: 8_000, cacheCreate: 0, thinking: 0 });
});
