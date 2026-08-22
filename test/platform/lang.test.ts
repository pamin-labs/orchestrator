import { expect, test } from "bun:test";
import { said } from "../support/said.ts";
import { renderSaid } from "../../src/platform/text/lang.ts";
import { LOCALES } from "../../src/contracts/config.ts";

/**
 * What the orchestrator says, in ten languages, rendered on the server.
 *
 * This file used to guard two hand-kept tables behind `isChinese()` — a language
 * *pair*, so `output.language: 한국어` got English. It then guarded a generated
 * table. What is left to check is the thing neither of those was: that a
 * descriptor an emitter wrote with `msg` finds its row in a catalogue compiled
 * into this binary.
 */
/** `said()` builds the descriptor the macro would have, so this is `renderSaid`
 *  with the sentence written out. */
const say = (lang: string, message: string, values?: Record<string, string | number>): string =>
  renderSaid(lang, said(message, values));

const MERGED = "merged into main";

test("a language that is neither English nor Chinese gets its own words", () => {
  // The bug this replaced: `isChinese(lang) ? ZH : EN` has no third row, so a
  // Korean boss read the feed in English however the knob was set.
  expect(say("한국어", MERGED)).not.toBe(MERGED);
  expect(say("Русский", MERGED)).toBe("влито в main");
  expect(say("English", MERGED)).not.toBe(say("Français", MERGED));
  // Free text a person typed, so `localeOf` decides; an unrecognised one is the
  // source language rather than nothing.
  expect(say("Klingon", MERGED)).toBe(MERGED);
  // A unit test builds a Ctx without config; a missing language is not a reason
  // to throw inside a bus.emit.
  expect(() => renderSaid(undefined, said("gate pass on S{seq}", { seq: 1 }))).not.toThrow();
});

test("every locale renders every sentence, and only English renders the source", () => {
  // The catalogues are imported modules in this process, exactly as they are in
  // the compiled binary — so an empty one, a locale missing from `CATALOGS`, or
  // a `.po` the bundler never compiled shows up here as English.
  const english = LOCALES.filter((l) => l !== "en" && say(l, MERGED) === MERGED);
  expect(english).toEqual([]);
});

/**
 * The `message` on the descriptor is what an id with no catalogue row falls back
 * to, and every English reader is that case — the source locale loads nothing.
 * A sentence this build has never seen is the other case, and it is what keeps
 * adding a message to the server non-breaking for a panel older than it.
 */
test("a sentence no catalogue carries renders from the descriptor it arrived with", () => {
  const unknown = {
    id: "a-hash-no-catalogue-has",
    message: "a newer server said this about {thing}",
    values: { thing: "a slice" },
  };
  expect(renderSaid("Русский", unknown)).toBe("a newer server said this about a slice");
  expect(renderSaid("English", unknown)).toBe("a newer server said this about a slice");
});

test("a plural reads right at one, which is what a bare {n} could not", () => {
  const turns = (n: number) =>
    say(
      "English",
      "{role} finished {n, plural, one {# turn} other {# turns}} without changing a file, a task or a note",
      {
        role: "engineer",
        n,
      },
    );
  expect(turns(1)).toContain("1 turn without");
  expect(turns(2)).toContain("2 turns without");
  // Russian has three plural categories and the catalogue picks between them.
  const batch = (n: number) => say("Русский", "{n, plural, one {# thing needs} other {# things need}} you:", { n });
  expect(batch(2)).toContain("дела");
  expect(batch(5)).toContain("дел");
  expect(
    say(
      "English",
      "the same feedback for the {n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} time; asking the CoS to make it a project rule",
      { n: 3 },
    ),
  ).toContain("3rd");
});
