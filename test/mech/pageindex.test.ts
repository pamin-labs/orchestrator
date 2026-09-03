import { readClaude } from "../../src/runtime/claude.ts";
import { readCodex } from "../../src/runtime/codex.ts";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import {
  chargeIndex,
  loadTree,
  noteLeaves,
  render,
  saveTree,
  search,
  skeleton,
  summarise,
  type Ask,
} from "../../src/mech/knowledge/pageindex.ts";
import { costReport } from "../../src/mech/ops/cost.ts";
import { count, eq } from "drizzle-orm";
import { agent, event, grp, note } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";
import { z } from "zod";
import { tempDir } from "../support/temp.ts";

/** The shipped numbers, not a literal beside them: a walk tested at a depth the
 *  product does not use proves nothing about the product's model bill. */
const WALK = loadConfig().pageindex;

const UsageMeta = z.object({ runtime: z.string(), cacheRatio: z.number() });

function repo(): string {
  const d = tempDir("orch-pi-");
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

test("a pass that runs out of budget keeps what the last one knew", async () => {
  // The index went backwards: 822 nodes, 61 summarised down to 48, while the
  // indexer's bill went 2.9M tokens to 23.3M. A directory's content *is* its
  // children's summaries, so one child left blank changed the parent's signature
  // — which needed a call the budget had already spent on files — and the
  // emptiness climbed one level per tick instead of the tree converging.
  const heads: Record<string, string> = { "src/a.ts": "first", "src/b.ts": "second" };
  const files = Object.keys(heads);
  const read = (id: string) => heads[id] ?? null;
  // The file answers differ with the content, because a directory's signature is
  // built out of them: a fake that answers the same string either way would make
  // the parent look unchanged and test nothing.
  const ask: Ask = async (p) =>
    p.includes("what does")
      ? "a directory of things"
      : p.includes("rewritten")
        ? "the rewritten file"
        : "a file summary";

  const full = await summarise(skeleton(files), read, ask);
  expect(full.tree["src/"]!.summary).toBe("a directory of things");

  // One file changes, and the pass can afford exactly one call — which the file
  // takes, leaving `src/` needing one it cannot have.
  heads["src/a.ts"] = "rewritten";
  const starved = await summarise(skeleton(files), read, ask, { previous: full.tree, maxCalls: 1 });
  expect(starved.calls).toBe(1);
  expect(starved.tree["src/b.ts"]!.summary).toBe("a file summary");
  expect(starved.tree["src/"]!.summary).toBe("a directory of things");

  // And it is still queued rather than quietly accepted: the carried signature is
  // the old content's, so the next pass with room re-summarises it.
  const caught = await summarise(skeleton(files), read, ask, { previous: starved.tree, maxCalls: 1 });
  expect(caught.calls).toBe(1);
  expect(caught.tree["src/"]!.summary).toBe("a directory of things");
});

test("a change past the head is still a change", async () => {
  // A file's identity was `sigOf(the first 1800 characters)`, so an edit in the
  // middle or at the end of a file moved nothing and its summary stayed as it was
  // — indefinitely, since nothing else would ever revisit it. Git already has a
  // hash of the whole file, and `sigFor` is where the caller hands it over.
  const heads: Record<string, string> = { "src/a.ts": "the same opening lines" };
  const blobs: Record<string, string> = { "src/a.ts": "aaa1" };
  const read = (id: string) => heads[id] ?? null;
  const sigFor = (id: string) => blobs[id] ?? null;
  const ask: Ask = async () => "a file summary";

  const first = await summarise(skeleton(["src/a.ts"]), read, ask, { sigFor });
  const quiet = await summarise(skeleton(["src/a.ts"]), read, ask, { previous: first.tree, sigFor });
  expect(quiet.calls).toBe(0);

  // The head is byte-for-byte what it was. The file is not.
  blobs["src/a.ts"] = "bbb2";
  const moved = await summarise(skeleton(["src/a.ts"]), read, ask, { previous: quiet.tree, sigFor });
  expect(moved.calls).toBe(1);
  expect(moved.tree["src/a.ts"]!.sig).toBe("bbb2");
});

test("a file the corpus will not hand over keeps its summary", async () => {
  // The third way out of the same function, and it was the one that skipped the
  // node entirely: a binary file, one too large to read, or one deleted between
  // the listing and the read left a blank leaf — and a blank leaf changes its
  // directory's signature, which is the cascade.
  const present: Record<string, string> = { "src/a.ts": "text" };
  const first = await summarise(
    skeleton(["src/a.ts"]),
    (id) => present[id] ?? null,
    async () => "a summary",
  );

  const gone = await summarise(
    skeleton(["src/a.ts"]),
    () => null,
    async () => "another",
    { previous: first.tree },
  );
  expect(gone.calls).toBe(0);
  expect(gone.tree["src/a.ts"]!.summary).toBe("a summary");
  expect(gone.tree["src/"]!.summary).toBe("a summary");
});

test("a model that answers nothing costs a call, not a summary", async () => {
  // The other way out of the same function. A failed call left the node blank on
  // a tree that already had an answer for it, which is the same cascade with a
  // different trigger — and the model being briefly down is ordinary.
  const heads: Record<string, string> = { "src/a.ts": "first" };
  const read = (id: string) => heads[id] ?? null;
  const full = await summarise(skeleton(Object.keys(heads)), read, async () => "a summary");

  heads["src/a.ts"] = "rewritten";
  const down = await summarise(skeleton(Object.keys(heads)), read, async () => "", { previous: full.tree });
  expect(down.failed).toBeGreaterThan(0);
  expect(down.tree["src/a.ts"]!.summary).toBe("a summary");
});

test("retrieval is the model walking the tree, not a similarity score", async () => {
  const dir = repo();
  const { tree } = await summarise(skeleton(FILES), dirRead(dir), async (p) =>
    // Matched on the id, not the wording: a prompt that gains a word — "in English"
    // did — must not silently turn this fake into one that answers "misc" to
    // everything, which is a passing test that has stopped testing anything.
    p.includes("what is src/mech/notify.ts") ? "the only place that talks to the OS notification centre" : "misc",
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
  const hits = await search(tree, "where does the desktop popup come from", ask, WALK);
  expect(hits).toEqual(["src/mech/notify.ts"]);
  expect(seen[0]).toContain("Which of these are worth opening");
  expect(render(tree, hits)).toContain("notification centre");
});

test("a navigator that finds nothing relevant says so instead of guessing", async () => {
  const dir = repo();
  const { tree } = await summarise(skeleton(FILES), dirRead(dir), async () => "s");
  expect(await search(tree, "how do I file my taxes", async () => "NONE", WALK)).toEqual([]);
});

test("the tree survives a round trip through the note it lives in", async () => {
  const db = await openMemory();
  await fx.on(db).project.create({ name: "p" });
  const { tree } = await summarise(skeleton(FILES), dirRead(repo()), async () => "s");
  await saveTree(db, 1, tree);
  await saveTree(db, 1, tree);
  expect((await db.select({ c: count() }).from(note).where(eq(note.kind, "pageindex")))[0]!.c).toBe(1);
  expect((await loadTree(db, 1))!["src/mech/gate.ts"]!.summary).toBe("s");
});

test("journals and retros are leaves in the same tree as the code", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  await f.project.create({ name: "p" });
  const g = await f.runningGrp.create({ project_id: 1, name: "g1" });
  await f.note.create({ grp_id: g.id, kind: "retro", body: "the flicker was the key, not the diffing" });

  const notes = await noteLeaves(db, 1);
  expect(notes.ids).toEqual(["notes/grp-1/retro/1"]);

  const { tree } = await summarise(skeleton(notes.ids), notes.read, async (p) =>
    p.includes("what does this note establish") ? "why the timeline flickered" : "the group's retros",
  );
  // The note prompt is the one that ran: a retro is not a source file and asking
  // "what is this file for" of one produces a summary of the format.
  expect(tree["notes/grp-1/retro/1"]!.summary).toBe("why the timeline flickered");

  const hits = await search(
    tree,
    "did anyone work out the flicker",
    async (p) => {
      const lines = (p.split("NONE if none of them are relevant.")[1] ?? "").trim().split("\n");
      return lines[0]!.split(" — ")[0]!;
    },
    WALK,
  );
  expect(hits).toEqual(["notes/grp-1/retro/1"]);
});

test("what the index spends shows up in the cost report", async () => {
  // The most frequent model call in the system appeared in no report at all: it
  // is not a turn, and `costReport` reads turns. It is charged to a standing
  // `indexer` row rather than to the Librarian, whose turns carry a full cached
  // prefix and a session — mixing the two makes "librarian took 4M" unusable.
  const db = await openMemory();
  await fx.on(db).project.create({ name: "p" });
  const ctx = await testContext({ db });
  const spec = { runtime: "codex", model: "gpt-5.6-luna" };

  await chargeIndex(ctx, 1, spec, { input: 100, output: 20, cacheRead: 5, cacheCreate: 1, thinking: 0 });
  await chargeIndex(ctx, 1, spec, { input: 10, output: 2, cacheRead: 0, cacheCreate: 0, thinking: 0 });

  const report = await costReport(db);
  expect(report.byRole.find((r) => r.label === "indexer")?.tokens).toBe(138);
  expect(report.byRuntime.find((r) => r.label === "codex")?.tokens).toBe(138);
  // One row per project, not one per call.
  expect((await db.select({ n: count() }).from(agent).where(eq(agent.role, "indexer")))[0]!.n).toBe(1);
  // And the hourly burn chart reads the events, which need the same meta shape a
  // turn emits or the provider split guesses from the model name.
  const [ev] = await db.select({ meta_json: event.meta_json }).from(event).where(eq(event.author, "indexer")).limit(1);
  const meta = UsageMeta.parse(ev!.meta_json);
  expect(meta.runtime).toBe("codex");
  // `cacheRatio` too, which "the same meta shape a turn emits" did not include.
  // `recentCacheRatio` averages the rows that carry one, and the index is fifty
  // rows to a turn's handful — so the number beside "the indexer is the whole of
  // the spend" was an average over whatever else happened to be in the sample.
  expect(meta.cacheRatio).toBeCloseTo(5 / 106, 5);
});

test("a call that reported no usage is not charged", async () => {
  // Missing numbers must never fail the index, and a zero row would be a lie in
  // the report rather than an absence.
  const db = await openMemory();
  await fx.on(db).project.create({ name: "p" });
  const ctx = await testContext({ db });
  await chargeIndex(
    ctx,
    1,
    { runtime: "codex", model: "m" },
    { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 },
  );
  expect((await db.select({ n: count() }).from(agent))[0]!.n).toBe(0);
});

test("Codex output keeps the last valid message and usage in one noisy stream", () => {
  const got = readCodex(
    [
      "Reading prompt from stdin…",
      "{not json",
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "ignore me" } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 },
      }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first answer" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final answer" } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10_000, cached_input_tokens: 8_000, output_tokens: 50 },
      }),
      "",
    ].join("\n"),
  );

  expect(got.text).toBe("final answer");
  expect(got.usage).toEqual({ input: 2_000, output: 50, cacheRead: 8_000, cacheCreate: 0, thinking: 0 });
});

test("Codex output tolerates absent valid records", () => {
  expect(readCodex("banner\n{bad json\n")).toEqual({ text: "" });
  expect(
    readCodex(
      [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "kept" } }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "   " } }),
      ].join("\n"),
    ).text,
  ).toBe("kept");
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

test("JSON-shaped malformed index output degrades without a cast", () => {
  expect(readClaude("null")).toEqual({ text: "" });
  expect(readClaude(JSON.stringify({ result: 1 }))).toEqual({ text: "" });
  expect(readCodex(["null", JSON.stringify({ type: "item.completed", item: null })].join("\n"))).toEqual({ text: "" });
});

/**
 * Every summary is asked for in English, and the prompt says so.
 *
 * `sigOf` hashes the file's content and nothing else, so a summary is rebuilt only
 * when the file changes. That makes its *language* something no mechanism can
 * correct: let it drift and the index holds two languages with signatures that will
 * never invalidate. English makes a summary a pure function of its input again,
 * which is what the incremental contract claims it already is.
 */
test("a summary is asked for in English, whatever the file is written in", async () => {
  const asked: string[] = [];
  const ask: Ask = async (prompt) => {
    asked.push(prompt);
    return "一句中文摘要";
  };
  const dir = repo();
  writeFileSync(join(dir, "src/mech/中文.ts"), "export const 常量 = 1; // 这是一个中文文件\n");
  await summarise(
    skeleton(["src/mech/notify.ts", "src/mech/中文.ts"]),
    (rel) => readFileSync(join(dir, rel), "utf8"),
    ask,
  );

  expect(asked.length).toBeGreaterThan(0);
  for (const prompt of asked) expect(prompt).toContain("in English");
});

/**
 * Depth was a literal, and depth is money.
 *
 * It decides how many **serial** model calls one `orch ctx query` makes — two per
 * question on the measured corpus, each with its own 60s timeout — which makes it
 * the most frequent model spend in the system. It sat as `opts.depth ?? 3` inside
 * the walk, where the boss could not see it and no setting could reach it.
 */
test("how far and how wide the walk goes is config, not a literal inside it", async () => {
  const { tree } = await summarise(skeleton(FILES), dirRead(repo()), async () => "s");
  const asks: string[] = [];
  const ask: Ask = async (p) => {
    asks.push(p);
    const lines = (p.split("NONE if none of them are relevant.")[1] ?? "").trim().split("\n");
    return lines[0]!.split(" — ")[0]!;
  };

  // Three levels between the root and a file, so depth 3 is three serial calls.
  await search(tree, "where is the notifier", ask, { enabled: true, depth: 3, width: 4 });
  expect(asks).toHaveLength(3);

  asks.length = 0;
  await search(tree, "where is the notifier", ask, { enabled: true, depth: 1, width: 2 });
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("at most 2 ids");

  // Moving the numbers was not the point; being able to is. These are the values
  // that shipped before the move, and this says so out of `config/default.yaml`.
  expect(WALK).toEqual({ enabled: true, depth: 3, width: 4 });
});

test("a requirement's own retrieval counts against its budget", async () => {
  // It did not. Index spend landed on the `indexer` agent row alone, so a group
  // could ask `orch ctx query` on every turn and its `spent_tokens` — the number
  // `sliceBudgetTokens` stops a runaway with — never moved. The most frequent
  // model call in the system was the one the budget could not see.
  const db = await openMemory();
  const f = fx.on(db);
  const p = await f.project.create({ name: "p" });
  const g = await f.runningGrp.create({ project_id: p.id, name: "g1" });
  const ctx = await testContext({ db });
  const spec = { runtime: "codex", model: "gpt-5.6-luna" };
  const spent = async () => (await db.select({ t: grp.spent_tokens }).from(grp))[0]?.t;

  await chargeIndex(ctx, p.id, spec, { input: 100, output: 20, cacheRead: 5, cacheCreate: 1, thinking: 0 }, g.id);
  expect(await spent()).toBe(126);

  // The rebuild belongs to no requirement: it is a project-scoped pass on a timer,
  // and charging it to whichever group happened to be open would be a wrong number
  // rather than a missing one.
  await chargeIndex(ctx, p.id, spec, { input: 10, output: 2, cacheRead: 0, cacheCreate: 0, thinking: 0 });
  expect(await spent()).toBe(126);
  // Both still reach the project-level total either way.
  expect((await costReport(db)).byRole.find((r) => r.label === "indexer")?.tokens).toBe(138);
});
