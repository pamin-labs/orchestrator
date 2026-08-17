import { expect, test } from "bun:test";
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

test("filler is rejected — it costs tokens forever and says nothing", () => {
  const r = validateJournal({ kind: "decision", body: "Basically we moved the check." });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("filler");
  expect(validateJournal({ kind: "decision", body: "其实这里改了 middleware。" }).ok).toBe(false);
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

test("self-review must not be vacuous", () => {
  for (const s of ["looks good", "LGTM", "no issues", "all good", ""]) {
    const r = validateSelfReview(s, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("carries no information");
  }
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
