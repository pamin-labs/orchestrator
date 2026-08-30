import { expect, test } from "bun:test";

/**
 * The active project file is a snapshot, not a log.
 *
 * It was cut to 136 lines on 2026-08-17 under a policy it still carries in its
 * own preamble, and was 3362 lines thirteen days later. The policy was written
 * in two places and held in neither, so it is a test now. Narrative belongs in
 * the commit body, in ADRs, and in `docs/project/archive/`.
 */
const CAP = 200;

test("the active project file stays a snapshot", async () => {
  const text = await Bun.file("docs/project/progress.md").text();
  const lines = text.split("\n");

  expect(lines.length).toBeLessThanOrEqual(CAP);

  // Entries were also being prepended above the title, so the file grew from
  // both ends and the newest three sat under no heading at all.
  expect(lines.find((line) => line.trim() !== "")).toBe("# Project progress");
});
