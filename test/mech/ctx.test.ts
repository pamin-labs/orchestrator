import { expect, test } from "bun:test";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { query, DEFAULT_BUDGET } from "../../src/mech/knowledge/ctx.ts";
import { terms } from "../../src/mech/knowledge/terms.ts";
import { makeNoteIndex } from "../../src/mech/knowledge/note-index.ts";
import * as fx from "../support/factories.ts";

/** `query` needs an index and every caller builds the same one. */
const queryWith = (db: DB, rest: Omit<Parameters<typeof query>[0], "db" | "index">) =>
  query({ db, index: makeNoteIndex(db), ...rest });

/**
 * A word made only of stop characters is a stop word.
 *
 * The rented list and the rented segmenter disagree about what a token is: \`zho\` is
 * 78 entries and every one is a single character, because it was built for a
 * character-splitting tokeniser. ICU hands back words, so 这 and 个 were both
 * filtered while 这个 sailed through as a content word — and it is one of the most
 * common tokens in any Chinese sentence.
 */
/**
 * A one-letter Latin token is noise; a one-character Han token is often a word.
 *
 * The length rule reads the *script* rather than the count, which is the whole of
 * why it is not `length > 1`. Dropping it entirely changed nothing any test could
 * see — measured by mutation — while putting every stray `a`, `x` and digit from a
 * path or a diff into the index as a term.
 */
test("length is judged by script, not by counting characters", () => {
  // Latin singles and bare digits go; a Han single stays, because 钱, 锁 and 图 are
  // words a query would reasonably be. 中 is not one of them here — it is on the
  // rented stop list, which is a different rule and would hide this one.
  expect(terms("a b x 7 _ 钱 锁")).toEqual(["钱", "锁"]);
  expect(terms("run x() twice")).toEqual(["run", "twice"]);
});

test("a multi-character token whose every character is a stop word is filtered", () => {
  expect(terms("这个接口应该返回错误码")).toEqual(["接口", "应该", "返回", "错误", "码"]);
  expect(terms("那个页面什么都没有")).not.toContain("那个");
  for (const word of ["这个", "那个", "一个", "还是", "就是", "不是", "什么", "几个"]) {
    expect(terms(`${word}测试`)).toEqual(["测试"]);
  }
});

/**
 * Latin is excluded from that rule, and it has to be: \`eng\` contains \`a\` and \`i\`.
 *
 * English does not compose words out of function words character by character, so
 * the rule would only ever be wrong there — \`ai\` is the cheapest proof.
 */
test("the rule does not reach Latin, where single letters are stop words", () => {
  expect(terms("the ai model")).toEqual(["ai", "model"]);
});

/**
 * Han only, which is narrower than the "not Latin" this first shipped as.
 *
 * The rule holds where a character is a morpheme. In an alphabet a single-letter
 * stop word is a preposition that happens to be one letter, and `rus` has nine — so
 * `тест`, the word this repository would be searched for most in Russian, was built
 * entirely out of stop characters and deleted.
 */
test("an alphabetic word built from stop letters survives", () => {
  for (const word of ["тест", "тестов", "система", "дом", "вода", "сова", "кот"]) {
    expect(terms(word)).toEqual([word]);
  }
});

/**
 * Deliberately under-inclusive: only what the rented list already covers, composed.
 *
 * 可以 and 没有 survive because 可 and 有 are not on it. Widening this by hand would
 * be the second stop word table ADR 021 refused, one script at a time.
 */
test("a word with one content character is content", () => {
  for (const word of ["上下", "大小", "以上", "起来", "自己", "如果", "因为", "所以", "可以", "没有"]) {
    expect(terms(word)).toEqual([word]);
  }
});

test("terms are words in whatever script the writing uses, and stopwords go", () => {
  // `use` survives now. The hand-written list dropped it along with `get`, `set`,
  // `make` and `need` — content words in a corpus about code — and the rented
  // English list does not.
  expect(terms("Should we use the middleware for auth?")).toEqual(["use", "middleware", "auth"]);
  // Chinese stop words go too, which the hand-written English-only list could not
  // do. Measured before this: `的` scored 3.77 as a search term against this
  // corpus, above `sandbox` at 3.13 — the highest-weighted term in the index was
  // a particle, because BM25 had no reason to think otherwise.
  const zh = terms("沙盒的容器是怎么做的");
  expect(zh).not.toContain("的");
  expect(zh).not.toContain("是");
  // Words, not characters. This used to split Han per character because a regex
  // cannot do better; ICU's word breaker can, so a query for 凭据 matches a term
  // rather than two of the commonest characters in the language.
  expect(terms("中文问候")).toEqual(["中文", "问候"]);
  // A path splits into components on purpose: a query for "auth" should match a
  // note that mentions src/auth/mw.ts, which a single opaque token would not.
  expect(terms("src/auth/mw.ts")).toEqual(["src", "auth", "mw.ts"]);
});

test("every script the corpus might be written in produces terms", () => {
  // The regex this replaced matched Latin, Han, Hiragana and Katakana and
  // nothing else, so Korean, Russian, Thai, Arabic and Greek notes returned zero
  // terms and were invisible to search — silently, because an empty term list
  // looks exactly like a document about nothing. For a project about to be
  // written in by people who do not all type Latin, that is the whole feature.
  const cases: Array<[string, string]> = [
    ["ko", "샌드박스 자격 증명 처리"],
    ["ru", "обработка учётных данных"],
    ["th", "การจัดการข้อมูลรับรอง"],
    ["ar", "معالجة بيانات الاعتماد"],
    ["el", "διαχείριση διαπιστευτηρίων"],
    ["ja", "サンドボックスの認証情報"],
  ];
  for (const [lang, text] of cases) {
    expect({ lang, n: terms(text).length }).toEqual({ lang, n: terms(text).length });
    expect(terms(text).length).toBeGreaterThan(1);
  }
  // And they are words, not characters: the katakana run is one term, not twelve.
  expect(terms("サンドボックスの認証情報")).toContain("認証");
});

/**
 * The ranking that stayed ours after Orama took the relevance.
 *
 * Orama answers how well words match; it cannot know that a recorded decision
 * is worth more to recall than a journal entry, or that this morning beats last
 * quarter. Those two are policy and they are still multiplied over the library's
 * score — so they are still what these assert, now through the index rather than
 * through a hand-written BM25.
 */

function indexed(rows: Array<{ kind: string; body: string; at?: number }>) {
  const db = openMemory();
  const p = fx.project.insert(db, { name: "p" });
  for (const row of rows) fx.note.insert(db, { project_id: p.id, kind: row.kind, body: row.body, at: row.at ?? 0 });
  const hits = (question: string, now = 0) => makeNoteIndex(db).search(question, { grpId: null, projectId: p.id }, now);
  return { db, hits };
}

test("a rare term beats a common one", () => {
  // Every document mentions middleware, so it carries almost no information;
  // "legacy" is what distinguishes them.
  const { hits } = indexed([
    { kind: "journal", body: "middleware middleware middleware middleware" },
    { kind: "journal", body: "middleware and the legacy header fallback" },
  ]);
  expect(hits("middleware legacy fallback")[0]!.doc.body).toContain("legacy");
});

test("a long document does not win merely by containing more words", () => {
  // Naive keyword counting scores these equally; length normalisation does not.
  const noise = "unrelated words ".repeat(200);
  const { hits } = indexed([
    { kind: "journal", body: `${noise} token check middleware` },
    { kind: "journal", body: "token check moved into middleware" },
  ]);
  expect(hits("token check middleware")[0]!.doc.body).toBe("token check moved into middleware");
});

test("a decision outranks a journal that matches equally well", () => {
  // What was settled and why is the highest-value thing to recall, and no search
  // library can know that — which is why the weight is applied after it.
  const body = "token check moved into middleware";
  const { hits } = indexed([
    { kind: "journal", body },
    { kind: "decision", body },
  ]);
  expect(hits("token middleware")[0]!.doc.kind).toBe("decision");
});

test("recency breaks a tie, but only mildly", () => {
  const now = 10 * 86_400_000;
  const body = "token check middleware";
  expect(
    indexed([
      { kind: "journal", body, at: 0 },
      { kind: "journal", body, at: now },
    ]).hits("token", now)[0]!.doc.at,
  ).toBe(now);

  // An old decision still beats a fresh journal: age is a nudge, not a verdict.
  expect(
    indexed([
      { kind: "decision", body, at: 0 },
      { kind: "journal", body, at: now },
    ]).hits("token", now)[0]!.doc.kind,
  ).toBe("decision");
});

test("a question of only stopwords finds nothing rather than everything", () => {
  const { hits } = indexed([{ kind: "journal", body: "x" }]);
  expect(hits("the and of")).toEqual([]);
});

test("a note written after the index was built is still found", () => {
  // The index is kept, not rebuilt per query, so freshness is a property rather
  // than an accident: without the stamp check, everything written during a
  // server's life would be invisible until it restarted.
  const db = openMemory();
  const p = fx.project.insert(db, { name: "p" });
  const index = makeNoteIndex(db);
  const ask = () => index.search("kestrel", { grpId: null, projectId: p.id }, 0);
  expect(ask()).toEqual([]);

  fx.note.insert(db, { project_id: p.id, kind: "decision", body: "the kestrel decision", at: 0 });
  expect(ask()).toHaveLength(1);

  // And a rewritten note, which `saveSingletonNote` does, is re-read rather than
  // served from the copy the index took the first time.
  db.run("UPDATE note SET body = 'the osprey decision', at = 1 WHERE project_id = ?", [p.id]);
  expect(ask()).toEqual([]);
  expect(index.search("osprey", { grpId: null, projectId: p.id }, 0)).toHaveLength(1);
});

function seeded(): DB {
  const db = openMemory();
  const p = fx.project.insert(db, { name: "p" });
  const g = fx.runningGrp.insert(db, { project_id: p.id, name: "g1" });
  fx.slice.insert(db, {
    grp_id: g.id,
    seq: 1,
    title: "zh support",
    accept_spec: 'greet("x","zh") returns 你好 x',
    status: "running",
  });
  const note = (kind: string, body: string, at: number) =>
    fx.note.insert(db, { project_id: p.id, grp_id: g.id, kind, body, at });
  note("decision", "lang 参数用 lang?: string + map 回退，不用字面量联合", 100);
  note("journal", "无关的日常记录", 200);
  return db;
}

test("the group's acceptance criteria come back whatever the question was", () => {
  const out = queryWith(seeded(), { grpId: 1, projectId: 1, question: "totally unrelated" });
  // They are the frame for every question inside a slice; an agent that has to
  // search for them will guess instead.
  expect(out).toContain("S1 [running] zh support");
  expect(out).toContain("你好 x");
});

test("a matching decision is retrieved and labelled", () => {
  const out = queryWith(seeded(), { grpId: 1, projectId: 1, question: "lang 参数怎么定的" });
  expect(out).toContain("## decision");
  expect(out).toContain("字面量联合");
});

test("the budget is a hard cap, not a suggestion", () => {
  const db = seeded();
  for (let i = 0; i < 200; i++) {
    fx.note.insert(db, {
      project_id: 1,
      grp_id: 1,
      kind: "journal",
      body: `middleware token check note ${i} ` + "x".repeat(500),
      at: i,
    });
  }

  const out = queryWith(db, { grpId: 1, projectId: 1, question: "middleware token check" });
  // An unbounded answer costs more than the file the agent was about to read,
  // which defeats the whole point of the verb.
  expect(out.length).toBeLessThanOrEqual(DEFAULT_BUDGET);

  const tight = queryWith(db, { grpId: 1, projectId: 1, question: "middleware token", budget: 800 });
  expect(tight.length).toBeLessThanOrEqual(800);
});

test("when the budget truncates, it says how many matches were dropped", () => {
  const db = seeded();
  for (let i = 0; i < 30; i++) {
    fx.note.insert(db, {
      project_id: 1,
      grp_id: 1,
      kind: "journal",
      body: `middleware token note ${i} ` + "x".repeat(400),
      at: i,
    });
  }
  const out = queryWith(db, { grpId: 1, projectId: 1, question: "middleware token", budget: 2000 });
  // Silent truncation reads as "that is everything there is", which is worse than
  // a smaller answer that admits what it left out.
  expect(out).toContain("more matches omitted");
});

test("an export path is shown so the agent can go read the file itself", () => {
  const db = seeded();
  fx.note.insert(db, {
    project_id: 1,
    grp_id: 1,
    kind: "retro",
    body: "S1 返工一次，验收标准写模糊了",
    export_path: "docs/journal/g1/003-retro.md",
    at: 300,
  });
  const out = queryWith(db, { grpId: 1, projectId: 1, question: "返工 验收标准" });
  expect(out).toContain("docs/journal/g1/003-retro.md");
});

test("the index's own rows are not answers to a question", () => {
  // `note` is where the PageIndex tree and the repo map live too, both keyed by
  // project and both rewritten whenever the repo changes — so an `ORDER BY at
  // DESC` window kept them at the top, `KIND_WEIGHT` had no entry for either so
  // they scored ×1.0, and one hit handed the agent a whole serialised tree that
  // ate the entire character budget.
  const db = openMemory();
  const p = fx.project.insert(db, { name: "p" });
  fx.runningGrp.insert(db, { project_id: p.id, name: "g1" });
  const tree = JSON.stringify({ "src/auth.ts": { summary: "auth auth auth token token" } });
  fx.note.insert(db, { project_id: p.id, kind: "pageindex", body: tree, at: 9 });
  fx.note.insert(db, { project_id: p.id, kind: "map", body: "src/\n  auth.ts — token", at: 9 });
  fx.note.insert(db, { project_id: p.id, kind: "decision", body: "token 校验放在中间件", at: 8 });

  const out = queryWith(db, { grpId: 1, projectId: 1, question: "token", budget: 4000 });
  expect(out).toContain("token 校验放在中间件");
  expect(out).not.toContain("pageindex");
  expect(out).not.toContain("summary");
});

test("a note quoted in the where section is not quoted again below it", () => {
  // `pageIndexContext` spells out the body of every note the model picked, and the
  // lexical search then finds the same notes — two copies of one note inside one
  // 16k budget, on the query whose whole point is to be cheaper than grepping.
  const db = openMemory();
  const p = fx.project.insert(db, { name: "p" });
  const body = "the validation library this fleet uses is zod, settled in 2026-03";
  const note = fx.note.insert(db, { project_id: p.id, kind: "decision", body });
  const where = `## tree\n\n### decision #${note.id}\n${body}`;
  const count = (haystack: string) => haystack.split(body).length - 1;

  // Without the list, the same note does arrive twice. That is the defect.
  expect(count(queryWith(db, { grpId: null, projectId: p.id, question: "validation library", where }))).toBe(2);

  // With it, once.
  expect(
    count(
      queryWith(db, { grpId: null, projectId: p.id, question: "validation library", where, whereNotes: [note.id] }),
    ),
  ).toBe(1);
});

/**
 * A query reaches a form of the word the note did not use.
 *
 * The index matched the exact surface form, so a boss searching `testing` missed a
 * note saying `tests`, and Russian and Arabic — where inflection is the norm rather
 * than the exception — could barely be searched at all.
 */
test("an inflected query finds the word it is a form of", () => {
  const { hits } = indexed([
    { kind: "journal", body: "the gate runs the tests before every merge" },
    { kind: "journal", body: "тесты проверяют граничные случаи" },
    { kind: "journal", body: "الاختبارات تغطي الحالات الحدية" },
    { kind: "journal", body: "the deploy script copies the bundle" },
  ]);
  expect(hits("testing")[0]?.doc.body).toContain("tests");
  expect(hits("тестов")[0]?.doc.body).toContain("тесты");
  expect(hits("اختبار")[0]?.doc.body).toContain("الاختبارات");
});

/**
 * Stemming is the index's, not `terms()`'.
 *
 * `repomap.ts` matches `terms(question)` against raw text with `includes`, where a
 * stem is a substring: `use` becomes `us`, which hits `status`, `bus` and `cluster`.
 * Both sides of *this* index go through one tokeniser, which is what makes it safe
 * here and unsafe there.
 */
test("terms() itself does not stem", () => {
  expect(terms("Should we use the middleware")).toEqual(["use", "middleware"]);
});

/**
 * Scripts Snowball has no stemmer for are left alone rather than handed one.
 *
 * Chinese, Japanese and Korean do not inflect; Thai is agglutinative. The English
 * stemmer returns each of these unchanged, which is what makes the dispatch safe
 * even where it has nothing to offer.
 */
test("a script with no stemmer is indexed as it was written", () => {
  const { hits } = indexed([
    { kind: "journal", body: "沙盒容器是怎么创建的" },
    { kind: "journal", body: "テストが浅すぎる" },
  ]);
  expect(hits("沙盒容器")[0]?.doc.body).toContain("沙盒");
  expect(hits("テスト")[0]?.doc.body).toContain("テスト");
});

/**
 * A decision that was overturned stops being retrieved.
 *
 * `KIND_WEIGHT` gives `decision` the highest weight there is, 1.6, because what was
 * settled and why is the most valuable thing to recall. That is exactly what makes a
 * superseded one harmful: a few months and a few hundred decisions in, an agent asks
 * the blackboard and gets the reversed one back, ranked above everything, with
 * nothing in the answer saying it no longer holds.
 */
test("a superseded decision is not what the blackboard answers with", () => {
  const db = openMemory();
  const p = fx.project.insert(db, { name: "p" });
  const old = fx.note.insert(db, {
    project_id: p.id,
    kind: "decision",
    body: "gate order is typecheck then lint then test",
    at: 0,
  });
  fx.note.insert(db, {
    project_id: p.id,
    kind: "decision",
    body: "gate order is lint then typecheck then test",
    at: 1,
    supersedes: old.id,
  });

  const hits = makeNoteIndex(db).search("gate order", { grpId: null, projectId: p.id }, 2);
  expect(hits.map((h) => h.doc.body)).toEqual(["gate order is lint then typecheck then test"]);
});

test("a question sharing no word with its answer is what lexical retrieval cannot do", () => {
  // The measurement that decides whether the model walk on top of this is worth
  // its two calls per question. Lexical scoring is exact-term matching, so it is
  // near-perfect when the asker already knows the vocabulary and blind when they
  // do not — and this asserts the blind spot rather than describing it, because
  // the argument for the walk rests entirely on it.
  const db = openMemory();
  const p = fx.project.insert(db, { name: "p" });
  const g = fx.runningGrp.insert(db, { project_id: p.id, name: "g1" });
  for (let n = 0; n < 30; n++) {
    fx.note.insert(db, { project_id: p.id, grp_id: g.id, kind: "journal", body: `Ran the gates, all green. ${n}` });
  }
  fx.note.insert(db, {
    project_id: p.id,
    grp_id: g.id,
    kind: "decision",
    body: "We chose zod over ajv for boundary parsing because it ships types.",
  });

  const ask = (question: string) =>
    query({ db, index: makeNoteIndex(db), grpId: g.id, projectId: p.id, question }).includes("chose zod over ajv");

  // Same words: found. No shared word: not found, and no ranking change fixes
  // that — it is the property of the algorithm, not a tuning failure.
  expect(ask("zod or ajv?")).toBe(true);
  expect(ask("which validation library did we pick?")).toBe(false);
  db.close();
});
