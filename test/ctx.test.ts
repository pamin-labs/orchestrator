import { expect, test } from "bun:test";
import { openMemory, type DB } from "../src/db.ts";
import { query, rank, terms, DEFAULT_BUDGET, type Doc } from "../src/mech/knowledge/ctx.ts";

const doc = (id: number, kind: string, body: string, at = 0): Doc => ({
  id,
  kind,
  body,
  exportPath: null,
  at,
  sliceId: null,
});

test("terms split Latin tokens and CJK characters, and drop stopwords", () => {
  expect(terms("Should we use the middleware for auth?")).toEqual(["middleware", "auth"]);
  // Chinese has no spaces, so per-character terms are what make it searchable at all.
  expect(terms("中文问候")).toEqual(["中", "文", "问", "候"]);
  // A path splits into components on purpose: a query for "auth" should match a
  // note that mentions src/auth/mw.ts, which a single opaque token would not.
  expect(terms("src/auth/mw.ts")).toEqual(["src", "auth", "mw.ts"]);
});

test("a rare term beats a common one", () => {
  const docs = [
    doc(1, "journal", "middleware middleware middleware middleware"),
    doc(2, "journal", "middleware and the legacy header fallback"),
  ];
  // Every document mentions middleware, so it carries almost no information;
  // "legacy" is what distinguishes them.
  const hits = rank(docs, "middleware legacy fallback");
  expect(hits[0]!.doc.id).toBe(2);
});

test("a long document does not win merely by containing more words", () => {
  const noise = "unrelated words ".repeat(200);
  const docs = [
    doc(1, "journal", `${noise} token check middleware`),
    doc(2, "journal", "token check moved into middleware"),
  ];
  // Naive keyword counting scores these equally; length normalisation does not.
  expect(rank(docs, "token check middleware")[0]!.doc.id).toBe(2);
});

test("a decision outranks a journal that matches equally well", () => {
  const body = "token check moved into middleware";
  const hits = rank([doc(1, "journal", body), doc(2, "decision", body)], "token middleware");
  // What was settled and why is the highest-value thing to recall.
  expect(hits[0]!.doc.kind).toBe("decision");
});

test("recency breaks a tie, but only mildly", () => {
  const now = 10 * 86_400_000;
  const body = "token check middleware";
  const recent = rank([doc(1, "journal", body, 0), doc(2, "journal", body, now)], "token", now);
  expect(recent[0]!.doc.id).toBe(2);

  // An old decision still beats a fresh journal: age is a nudge, not a verdict.
  const mixed = rank([doc(1, "decision", body, 0), doc(2, "journal", body, now)], "token", now);
  expect(mixed[0]!.doc.kind).toBe("decision");
});

test("no query terms and no documents both return nothing rather than everything", () => {
  expect(rank([doc(1, "journal", "x")], "the and of")).toEqual([]);
  expect(rank([], "middleware")).toEqual([]);
});

function seeded(): DB {
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, status, created_at) VALUES (1, 1, 'zh support', 'greet(\"x\",\"zh\") returns 你好 x', 'running', 0)",
  );
  const ins = db.prepare("INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (1, 1, ?, 'zh', ?, ?)");
  ins.run("decision", "lang 参数用 lang?: string + map 回退，不用字面量联合", 100);
  ins.run("journal", "无关的日常记录", 200);
  return db;
}

test("the group's acceptance criteria come back whatever the question was", () => {
  const out = query({ db: seeded(), grpId: 1, projectId: 1, question: "totally unrelated" });
  // They are the frame for every question inside a slice; an agent that has to
  // search for them will guess instead.
  expect(out).toContain("S1 [running] zh support");
  expect(out).toContain("你好 x");
});

test("a matching decision is retrieved and labelled", () => {
  const out = query({ db: seeded(), grpId: 1, projectId: 1, question: "lang 参数怎么定的" });
  expect(out).toContain("## decision");
  expect(out).toContain("字面量联合");
});

test("the budget is a hard cap, not a suggestion", () => {
  const db = seeded();
  const ins = db.prepare(
    "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (1, 1, 'journal', 'zh', ?, ?)",
  );
  for (let i = 0; i < 200; i++) ins.run(`middleware token check note ${i} ` + "x".repeat(500), i);

  const out = query({ db, grpId: 1, projectId: 1, question: "middleware token check" });
  // An unbounded answer costs more than the file the agent was about to read,
  // which defeats the whole point of the verb.
  expect(out.length).toBeLessThanOrEqual(DEFAULT_BUDGET);

  const tight = query({ db, grpId: 1, projectId: 1, question: "middleware token", budget: 800 });
  expect(tight.length).toBeLessThanOrEqual(800);
});

test("when the budget truncates, it says how many matches were dropped", () => {
  const db = seeded();
  const ins = db.prepare(
    "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (1, 1, 'journal', 'zh', ?, ?)",
  );
  for (let i = 0; i < 30; i++) ins.run(`middleware token note ${i} ` + "x".repeat(400), i);
  const out = query({ db, grpId: 1, projectId: 1, question: "middleware token", budget: 2000 });
  // Silent truncation reads as "that is everything there is", which is worse than
  // a smaller answer that admits what it left out.
  expect(out).toContain("more matches omitted");
});

test("an export path is shown so the agent can go read the file itself", () => {
  const db = seeded();
  db.run(
    "INSERT INTO note (project_id, grp_id, kind, lang, body, export_path, at) VALUES (1, 1, 'retro', 'zh', 'S1 返工一次，验收标准写模糊了', 'docs/journal/g1/003-retro.md', 300)",
  );
  const out = query({ db, grpId: 1, projectId: 1, question: "返工 验收标准" });
  expect(out).toContain("docs/journal/g1/003-retro.md");
});

test("the index's own rows are not answers to a question", () => {
  // `note` is where the PageIndex tree and the repo map live too, both keyed by
  // project and both rewritten whenever the repo changes — so an `ORDER BY at
  // DESC` window kept them at the top, `KIND_WEIGHT` had no entry for either so
  // they scored ×1.0, and one hit handed the agent a whole serialised tree that
  // ate the entire character budget.
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  const tree = JSON.stringify({ "src/auth.ts": { summary: "auth auth auth token token" } });
  db.run("INSERT INTO note (project_id, kind, body, at) VALUES (1, 'pageindex', ?, 9)", [tree]);
  db.run("INSERT INTO note (project_id, kind, body, at) VALUES (1, 'map', 'src/\n  auth.ts — token', 9)");
  db.run("INSERT INTO note (project_id, kind, body, at) VALUES (1, 'decision', 'token 校验放在中间件', 8)");

  const out = query({ db, grpId: 1, projectId: 1, question: "token", budget: 4000 });
  expect(out).toContain("token 校验放在中间件");
  expect(out).not.toContain("pageindex");
  expect(out).not.toContain("summary");
});
