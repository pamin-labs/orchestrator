import { describe, expect, test } from "bun:test";
import { validateJournal, validateSelfReview } from "../../src/mech/util/validate.ts";

const six = "a\nb\nc\nd\ne\nf";

test("six lines pass, seven are rejected", () => {
  expect(validateJournal({ kind: "decision", body: six }).ok).toBe(true);
  const r = validateJournal({ kind: "decision", body: six + "\ng" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("7 lines");
});

test("blank lines do not count toward the limit", () => {
  expect(validateJournal({ kind: "journal", body: "a\n\n\nb\n\nc" }).ok).toBe(true);
});

test("unknown kind is rejected with the allowed list", () => {
  const r = validateJournal({ kind: "musings", body: "x" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("retro");
});

test("empty body is rejected", () => {
  expect(validateJournal({ kind: "retro", body: "   \n  " }).ok).toBe(false);
});

/**
 * Terseness has one owner, and it reads ten languages.
 *
 * A second check refused a journal containing "basically" or 其实 — two
 * languages of lexicon in a product that writes in ten, so an entry a German
 * agent padded was accepted and the same entry in English was not. The line cap
 * is the language-free rule that was already doing this job. ADR 046.
 */
test("padding is refused by the line cap, in whatever language it is padded in", () => {
  const padded = (line: string) => validateJournal({ kind: "decision", body: Array(9).fill(line).join("\n") });
  for (const line of ["basically we moved the check", "其实这里改了 middleware", "wir haben die Prüfung verschoben"]) {
    const r = padded(line);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("max");
  }
  // And a short entry is accepted whichever of the ten it is written in — the
  // lexicon refused two of them and nothing else.
  for (const line of [
    "Basically we moved the check.",
    "其实这里改了 middleware。",
    "Wir haben die Prüfung verschoben.",
  ]) {
    expect(validateJournal({ kind: "decision", body: line }).ok).toBe(true);
  }
});

test("a real entry passes and is normalised", () => {
  const r = validateJournal({
    kind: "decision",
    body: "Token check moved into middleware.  \nOld spot queried the DB twice per request.\n",
    files: ["auth/mw.ts"],
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.lines).toBe(2);
    expect(r.body).toBe("Token check moved into middleware.\nOld spot queried the DB twice per request.");
  }
});

/**
 * A non-answer is refused by counting verdicts, not by recognising the ways
 * there are to say nothing.
 *
 * `pass` and `fail` are the two words `roles/engineer.yaml` and `roles/qa.yaml`
 * hand out, so counting them is language-free. The lexicon this replaced knew
 * `looks good`, `lgtm` and four more, in English, and also accepted `ok`, `met`
 * and `not met` as verdicts — so `looks ok` counted and `bestanden` did not.
 */
describe("self-review must not be vacuous", () => {
  test("an empty review is its own message, because there is nothing to count", () => {
    const r = validateSelfReview("", 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("says nothing at all");
  });

  test.each(["looks good", "LGTM", "no issues", "all good", "sieht gut aus", "看起来没问题", "looks ok"])(
    "%s is refused",
    (body) => {
      const r = validateSelfReview(body, 2);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("covered 0 of 2");
    },
  );
});

test("self-review must cover every acceptance criterion", () => {
  const partial = "criterion 1: pass, see mw.ts:31";
  const r = validateSelfReview(partial, 3);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("1 of 3");

  const full = [
    "criterion 1: pass — mw.ts:31 checks the token before the handler",
    "criterion 2: pass — added test in mw.test.ts:12",
    "criterion 3: fail — legacy header path not covered yet",
  ].join("\n");
  const ok = validateSelfReview(full, 3);
  expect(ok.ok).toBe(true);
  if (ok.ok) expect(ok.checked).toBe(3);
});
