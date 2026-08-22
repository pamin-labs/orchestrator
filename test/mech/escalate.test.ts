import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { join } from "node:path";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { escalation } from "../../src/platform/persistence/schema.ts";
import { escalationKey, raise } from "../../src/mech/flow/escalate.ts";
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
  const ask = { key: escalationKey.auth("claude"), dedupe: { scope: "global" } } as const;

  expect(await raise(db, { ...ask, grpId: 1, question: "claude credential expired" })).toBeNumber();
  expect(await raise(db, { ...ask, grpId: 2, question: "claude credential refused" })).toBeNull();
  expect((await rows(db)).map((r) => r.grp_id)).toEqual([1]);
});

test("group dedupe suppresses one group without hiding another", async () => {
  const db = await seeded();
  const ask = (grpId: number, suffix: string) =>
    raise(db, {
      grpId,
      question: `out of budget: ${suffix}`,
      key: escalationKey.budget,
      dedupe: { scope: "group", grpId },
    });

  expect(await ask(1, "first")).toBeNumber();
  expect(await ask(1, "again")).toBeNull();
  expect(await ask(2, "first")).toBeNumber();
  expect((await rows(db)).map((r) => r.grp_id)).toEqual([1, 2]);
});

test("answered and revoked questions re-arm the same subject", async () => {
  const db = await seeded();
  const ask = () =>
    raise(db, {
      question: "GitHub me/x: unavailable",
      key: escalationKey.githubRepo("me/x"),
      dedupe: { scope: "global" },
    });

  expect(await ask()).toBeNumber();
  expect(await ask()).toBeNull();
  await db.update(escalation).set({ chain_state: "answered", answer: "fixed" }).where(eq(escalation.id, 1));
  expect(await ask()).toBeNumber();
  await db.update(escalation).set({ chain_state: "revoked" }).where(eq(escalation.id, 2));
  expect(await ask()).toBeNumber();
  expect(await rows(db)).toHaveLength(3);
});

test("the wording of a question is not its identity", async () => {
  // The whole point of `dedupe_key`. Every sentence here is different from every
  // other and none of them is what the product ships; the key is the same one,
  // and that is what decides. Before this column the second call would have filed
  // a second row, because `starts_with(question, prefix)` found nothing.
  const db = await seeded();
  const ask = (question: string) =>
    raise(db, { question, key: escalationKey.auth("claude"), dedupe: { scope: "global" } });

  expect(await ask("The claude credential stopped working")).toBeNumber();
  expect(await ask("Клод больше не принимает этот логин")).toBeNull();
  expect(await ask("something else entirely, rewritten by a translator")).toBeNull();
  expect(await rows(db)).toHaveLength(1);
});

test("a key with SQL metacharacters in it is compared literally", async () => {
  // A repository slug or a provider name is interpolated into a key, and `%`,
  // `_` and `\\` are ordinary characters in one. They were the reason the old
  // matchers had to use `starts_with` and hand-escaped `LIKE`; an `=` has no
  // pattern to escape, and this states that rather than assuming it.
  const db = await seeded();
  for (const [slug, near] of [
    ["me/rate%limit", "me/rateXlimit"],
    ["me/under_score", "me/underXscore"],
    [String.raw`me/path\\name`, String.raw`me/pathXname`],
    ["me/quote' OR 1=1 --", "me/different"],
  ] as const) {
    const ask = (s: string, q: string) =>
      raise(db, { question: q, key: escalationKey.githubRepo(s), dedupe: { scope: "global" } });
    expect(await ask(near, "a nearby repository")).toBeNumber();
    expect(await ask(slug, "this repository")).toBeNumber();
    expect(await ask(slug, "this repository again")).toBeNull();
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

test("no SQL compares the prose of a question", () => {
  // This is the rule the column exists for, and it is stated over the whole tree
  // rather than over the five matchers that had to be fixed — the sixth is the
  // one that will not remember. `question` and `brief` are sentences a translator
  // may rewrite, so a predicate over either is a matcher that fails silently the
  // next time somebody improves the wording. `dedupe_key` is what compares.
  const compares =
    /\b(?:like|ilike|starts_with|substr|position|left|right)\s*\(\s*(?:sql`\s*)?\$?\{?\s*escalations?\.(question|brief)\b/gi;
  const offenders = sources().flatMap((source) =>
    [...source.text.matchAll(compares)].map((m) => `${source.path}: ${m[1]}`),
  );
  expect(offenders).toEqual([]);
});
