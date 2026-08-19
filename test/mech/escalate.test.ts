import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { join } from "node:path";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { escalation } from "../../src/platform/persistence/schema.ts";
import { raise } from "../../src/mech/flow/escalate.ts";
import * as fx from "../support/factories.ts";

const rows = (db: DB) =>
  db
    .select({
      grp_id: escalation.grp_id,
      agent_id: escalation.agent_id,
      severity: escalation.severity,
      question: escalation.question,
      brief: escalation.brief,
      kind: escalation.kind,
      chain_state: escalation.chain_state,
    })
    .from(escalation)
    .orderBy(asc(escalation.id));

async function seeded(): Promise<DB> {
  const db = await openMemory();
  const f = fx.on(db);
  const p = await f.project.create({ name: "p" });
  for (const id of [1, 2, 7]) await f.runningGrp.create({ id, project_id: p.id, name: `g${id}` });
  await f.agent.create({ id: 9, project_id: p.id, grp_id: 7 });
  return db;
}

/** Every runtime TypeScript source, relative to `src/`. */
function sources(
  dir = new URL("../../src", import.meta.url).pathname,
  root = dir,
): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  // `withFileTypes`, so the kind comes back from the same `readdir` call that
  // produced the name. It was a `statSync` on the joined path afterwards, which
  // is a second syscall against a path that could have changed in between —
  // CodeQL's `js/file-system-race`, and correct: check-then-use on a filesystem
  // is a race whether or not anything is racing today. The dirent closes the
  // window rather than narrowing it, and costs a syscall less.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path, root));
    else if (entry.name.endsWith(".ts"))
      out.push({ path: path.slice(root.length + 1), text: readFileSync(path, "utf8") });
  }
  return out;
}

test("raise owns the filing defaults and preserves explicit fields", async () => {
  const db = await seeded();
  const first = await raise(db, { question: "which library?" });
  const second = await raise(db, {
    grpId: 7,
    agentId: 9,
    severity: "advisory",
    question: "the browser is missing",
    brief: "browser missing",
    kind: "env",
    chain: "boss",
  });

  expect(first).toBeNumber();
  expect(second).toBeNumber();
  expect(await rows(db)).toEqual([
    {
      grp_id: null,
      agent_id: null,
      severity: "blocker",
      question: "which library?",
      brief: null,
      kind: null,
      chain_state: "pm",
    },
    {
      grp_id: 7,
      agent_id: 9,
      severity: "advisory",
      question: "the browser is missing",
      brief: "browser missing",
      kind: "env",
      chain_state: "boss",
    },
  ]);
});

test("global dedupe is independent of the group attached to the row", async () => {
  const db = await seeded();
  const dedupe = { prefix: "claude credential", scope: "global" } as const;

  expect(await raise(db, { grpId: 1, question: "claude credential expired", dedupe })).toBeNumber();
  expect(await raise(db, { grpId: 2, question: "claude credential refused", dedupe })).toBeNull();
  expect((await rows(db)).map((r) => r.grp_id)).toEqual([1]);
});

test("group dedupe suppresses one group without hiding another", async () => {
  const db = await seeded();
  const ask = (grpId: number, suffix: string) =>
    raise(db, {
      grpId,
      question: `budget: ${suffix}`,
      dedupe: { prefix: "budget:", scope: "group", grpId },
    });

  expect(await ask(1, "first")).toBeNumber();
  expect(await ask(1, "again")).toBeNull();
  expect(await ask(2, "first")).toBeNumber();
  expect((await rows(db)).map((r) => r.grp_id)).toEqual([1, 2]);
});

test("answered and revoked questions re-arm the same subject", async () => {
  const db = await seeded();
  const dedupe = { prefix: "GitHub me/x:", scope: "global" } as const;
  const ask = () => raise(db, { question: "GitHub me/x: unavailable", dedupe });

  expect(await ask()).toBeNumber();
  expect(await ask()).toBeNull();
  await db.update(escalation).set({ chain_state: "answered", answer: "fixed" }).where(eq(escalation.id, 1));
  expect(await ask()).toBeNumber();
  await db.update(escalation).set({ chain_state: "revoked" }).where(eq(escalation.id, 2));
  expect(await ask()).toBeNumber();
  expect(await rows(db)).toHaveLength(3);
});

test("dedupe prefixes are literal data, not LIKE patterns", async () => {
  const db = await seeded();
  for (const [prefix, near] of [
    ["rate%limit", "rateXlimit"],
    ["under_score", "underXscore"],
    [String.raw`path\\name`, String.raw`pathXname`],
    ["quote' OR 1=1 --", "different"],
  ] as const) {
    expect(await raise(db, { question: `${near}: first`, dedupe: { prefix, scope: "global" } })).toBeNumber();
    expect(await raise(db, { question: `${prefix}: exact`, dedupe: { prefix, scope: "global" } })).toBeNumber();
    expect(await raise(db, { question: `${prefix}: again`, dedupe: { prefix, scope: "global" } })).toBeNull();
  }
  expect(await rows(db)).toHaveLength(8);
});

test("runtime escalation rows can only be filed through raise", () => {
  // Defaults and the meaning of "open" only stay unified if a new caller cannot
  // quietly copy the write again. Both spellings, because the raw INSERT this
  // started as is still the easiest thing for a new caller to reach for — and
  // the persistence owner's exception went away with its raw statement.
  const insert = /INSERT\s+INTO\s+escalation\b|\.insert\(\s*escalation\s*\)/gi;
  const offenders = sources()
    .filter((source) => source.path !== "mech/flow/escalate.ts")
    .flatMap((source) => [...source.text.matchAll(insert)].map(() => source.path));
  expect(offenders).toEqual([]);
});

test("dynamic escalation subjects are never matched as LIKE patterns", () => {
  // Repository slugs and provider names may contain `_`, which LIKE treats as a
  // one-character wildcard. Filing already compares literal prefixes; every
  // reverse path that answers or revokes one must use the same identity rule.
  // Drizzle spells it `like(escalation.question, …)`, and a constant pattern is
  // fine — what must not appear is an interpolated one with no escape in it.
  const offenders = sources().flatMap((source) => [
    ...[...source.text.matchAll(/\b(?:question|brief|kind)\s+LIKE\s+\?/gi)].map(() => source.path),
    ...[...source.text.matchAll(/\blike\(\s*escalation\.\w+,[^\n]*/gi)]
      .filter((m) => m[0].includes("${") && !m[0].includes(String.raw`[%_\\]`))
      .map(() => source.path),
  ]);
  expect(offenders).toEqual([]);
});
