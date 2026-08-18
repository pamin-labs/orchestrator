import { expect, test } from "bun:test";
import { skillsQuery } from "../../web/src/features/composer/model.ts";
import { SkillsQuery } from "../../src/api/panel/panel.ts";

/**
 * 技能 is machine-scope: the staged directory is mounted into every group of
 * every project, so the list exists before any project does.
 *
 * Both callers built the query as `String(projectId ?? "")`, which sends
 * `project=` rather than nothing. Opening the section with no project selected
 * answered "Too small: expected number to be >0" and rendered no skills at all.
 *
 * Two halves, and the schema half alone does not fix it — which is why both are
 * asserted here.
 */

test("no project means the parameter is absent, not blank", () => {
  expect(skillsQuery(null)).toEqual({});
  expect(skillsQuery(undefined)).toEqual({});
  expect(skillsQuery(7)).toEqual({ project: "7" });
});

test("the endpoint admits an absent project but still rejects a blank one", () => {
  // `.optional()` short-circuits on `undefined` only. An empty string is a
  // present value, so it reaches `z.coerce.number()`, becomes 0, and fails
  // `.positive()` — widening the schema without fixing the caller would have
  // left the section exactly as broken.
  expect({
    absent: SkillsQuery.safeParse({}).success,
    blank: SkillsQuery.safeParse({ project: "" }).success,
  }).toEqual({ absent: true, blank: false });
  expect(SkillsQuery.safeParse({ project: "7" })).toMatchObject({ data: { project: 7 } });
});
