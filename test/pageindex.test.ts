import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../src/db.ts";
import { loadTree, render, saveTree, search, skeleton, summarise, type Ask } from "../src/mech/pageindex.ts";

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "orch-pi-"));
  mkdirSync(join(d, "src/mech"), { recursive: true });
  writeFileSync(join(d, "src/mech/notify.ts"), "export function push(){} // desktop notifications\n");
  writeFileSync(join(d, "src/mech/gate.ts"), "export function runGates(){} // deterministic checks\n");
  return d;
}
const FILES = ["src/mech/notify.ts", "src/mech/gate.ts"];

test("the tree is structure first, and every node gets one summary", async () => {
  const dir = repo();
  const asks: string[] = [];
  const ask: Ask = async (p) => {
    asks.push(p);
    return p.includes("notify") ? "sends notifications to the boss" : "one line";
  };
  const { tree, calls } = await summarise(skeleton(FILES), dir, ask);

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
  const first = await summarise(skeleton(FILES), dir, ask);
  const again = await summarise(skeleton(FILES), dir, ask, { previous: first.tree });
  expect(again.calls).toBe(0);
  expect(again.tree["src/mech/gate.ts"]!.summary).toBe("a summary");
});

test("retrieval is the model walking the tree, not a similarity score", async () => {
  const dir = repo();
  const { tree } = await summarise(skeleton(FILES), dir, async (p) =>
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
  const { tree } = await summarise(skeleton(FILES), dir, async () => "s");
  expect(await search(tree, "how do I file my taxes", async () => "NONE")).toEqual([]);
});

test("the tree survives a round trip through the note it lives in", async () => {
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  const { tree } = await summarise(skeleton(FILES), repo(), async () => "s");
  saveTree(db, 1, tree);
  saveTree(db, 1, tree);
  expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM note WHERE kind = 'pageindex'").get()!.c).toBe(1);
  expect(loadTree(db, 1)!["src/mech/gate.ts"]!.summary).toBe("s");
});
