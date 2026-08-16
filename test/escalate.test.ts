import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openMemory, type DB } from "../src/db.ts";
import { raise } from "../src/mech/flow/escalate.ts";

interface Row {
  grp_id: number | null;
  agent_id: number | null;
  severity: string;
  question: string;
  brief: string | null;
  kind: string | null;
  chain_state: string;
}

const rows = (db: DB): Row[] =>
  db
    .query<Row, []>("SELECT grp_id, agent_id, severity, question, brief, kind, chain_state FROM escalation ORDER BY id")
    .all();

function seeded(): DB {
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (id, project_id, name, status, created_at) VALUES (1, 1, 'g1', 'RUNNING', 0)");
  db.run("INSERT INTO grp (id, project_id, name, status, created_at) VALUES (2, 1, 'g2', 'RUNNING', 0)");
  db.run("INSERT INTO grp (id, project_id, name, status, created_at) VALUES (7, 1, 'g7', 'RUNNING', 0)");
  db.run("INSERT INTO agent (id, project_id, grp_id, role, model, created_at) VALUES (9, 1, 7, 'engineer', 'm', 0)");
  return db;
}

/** Every runtime TypeScript source, relative to `src/`. */
function sources(dir = new URL("../src", import.meta.url).pathname, root = dir): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path, root));
    else if (entry.endsWith(".ts")) out.push({ path: path.slice(root.length + 1), text: readFileSync(path, "utf8") });
  }
  return out;
}

test("raise owns the filing defaults and preserves explicit fields", () => {
  const db = seeded();
  const first = raise(db, { question: "which library?" });
  const second = raise(db, {
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
  expect(rows(db)).toEqual([
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

test("global dedupe is independent of the group attached to the row", () => {
  const db = seeded();
  const dedupe = { prefix: "claude credential", scope: "global" } as const;

  expect(raise(db, { grpId: 1, question: "claude credential expired", dedupe })).toBeNumber();
  expect(raise(db, { grpId: 2, question: "claude credential refused", dedupe })).toBeNull();
  expect(rows(db).map((r) => r.grp_id)).toEqual([1]);
});

test("group dedupe suppresses one group without hiding another", () => {
  const db = seeded();
  const ask = (grpId: number, suffix: string) =>
    raise(db, {
      grpId,
      question: `budget: ${suffix}`,
      dedupe: { prefix: "budget:", scope: "group", grpId },
    });

  expect(ask(1, "first")).toBeNumber();
  expect(ask(1, "again")).toBeNull();
  expect(ask(2, "first")).toBeNumber();
  expect(rows(db).map((r) => r.grp_id)).toEqual([1, 2]);
});

test("answered and revoked questions re-arm the same subject", () => {
  const db = seeded();
  const dedupe = { prefix: "GitHub me/x:", scope: "global" } as const;
  const ask = () => raise(db, { question: "GitHub me/x: unavailable", dedupe });

  expect(ask()).toBeNumber();
  expect(ask()).toBeNull();
  db.run("UPDATE escalation SET chain_state = 'answered', answer = 'fixed' WHERE id = 1");
  expect(ask()).toBeNumber();
  db.run("UPDATE escalation SET chain_state = 'revoked' WHERE id = 2");
  expect(ask()).toBeNumber();
  expect(rows(db)).toHaveLength(3);
});

test("dedupe prefixes are literal data, not LIKE patterns", () => {
  const db = seeded();
  for (const [prefix, near] of [
    ["rate%limit", "rateXlimit"],
    ["under_score", "underXscore"],
    [String.raw`path\\name`, String.raw`pathXname`],
    ["quote' OR 1=1 --", "different"],
  ] as const) {
    expect(raise(db, { question: `${near}: first`, dedupe: { prefix, scope: "global" } })).toBeNumber();
    expect(raise(db, { question: `${prefix}: exact`, dedupe: { prefix, scope: "global" } })).toBeNumber();
    expect(raise(db, { question: `${prefix}: again`, dedupe: { prefix, scope: "global" } })).toBeNull();
  }
  expect(rows(db)).toHaveLength(8);
});

test("runtime escalation rows can only be filed through raise", () => {
  // Defaults and the meaning of "open" only stay unified if a new caller cannot
  // quietly copy the INSERT again. `db.ts` is the one exception: it files a data
  // repair while the database itself is opening, below the runtime flow layer.
  const insert = /INSERT\s+INTO\s+escalation\b/gi;
  const offenders: string[] = [];
  for (const source of sources()) {
    const matches = [...source.text.matchAll(insert)];
    if (source.path === "mech/flow/escalate.ts") continue;
    if (source.path === "db.ts") {
      for (const match of matches) {
        const before = source.text.slice(Math.max(0, match.index - 180), match.index);
        if (!before.includes("Escalation INSERT exception:")) offenders.push(source.path);
      }
      continue;
    }
    offenders.push(...matches.map(() => source.path));
  }
  expect(offenders).toEqual([]);
});

test("dynamic escalation subjects are never matched as LIKE patterns", () => {
  // Repository slugs and provider names may contain `_`, which LIKE treats as a
  // one-character wildcard. Filing already compares literal prefixes; every
  // reverse path that answers or revokes one must use the same identity rule.
  const offenders = sources().flatMap((source) =>
    [...source.text.matchAll(/\b(?:question|brief|kind)\s+LIKE\s+\?/gi)].map(() => source.path),
  );
  expect(offenders).toEqual([]);
});
