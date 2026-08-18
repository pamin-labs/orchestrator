import { describe, expect, test } from "bun:test";
import {
  findById,
  isHome,
  projectForGroup,
  scrollClass,
  settingsInitial,
  showNewRequirement,
  showRequirementCrumb,
  showSide,
  VIEWS,
  viewActive,
  waitingProject,
} from "../../web/src/features/navigation/model.ts";

/**
 * The navigation rules that are rules, as opposed to the ternaries beside them.
 *
 * `fallow health --coverage-gaps` named nineteen exports in this module and they
 * are not one kind of thing. `choose(condition, yes, no)`, `idOrZero`, `orEmpty`
 * and the four `*Class` helpers are one-line expressions whose test would be a
 * test of the ternary operator, and `docs/standards/testing.md` says not to
 * write those. What is below is the other kind: rules with a condition somebody
 * chose, which are wrong quietly when they drift.
 */

/**
 * `req` is reached from `progress` and is not a sibling of it, so the strip has
 * to keep showing where the reader came from — otherwise opening a requirement
 * makes the whole navigation look unselected. A case per pair, because which
 * pair drifted is the thing a bare `expected true, received false` withholds.
 */
describe("a requirement keeps its project's tab lit", () => {
  test.each([
    ["req", "progress", true],
    ["progress", "progress", true],
    ["req", "notes", false],
    // Not symmetric: being on the list does not light the requirement.
    ["progress", "req", false],
  ] as const)("on %s, the %s tab is lit: %p", (view, tab, lit) => {
    expect(viewActive(view, tab)).toBe(lit);
  });
});

/**
 * A link into 记录 on a machine with no project has nowhere to land, and the
 * fallback has to happen here rather than at each view.
 */
describe("no project is home, whatever the hash asked for", () => {
  test.each([
    ["notes", false, true],
    ["home", true, true],
    ["notes", true, false],
  ] as const)("view %s with a project: %p is home: %p", (view, hasProject, home) => {
    expect(isHome(view, hasProject)).toBe(home);
  });
});

describe("the event stream needs all three of its conditions", () => {
  test.each([
    ["asked for, not home, something to stream", true, false, 1, true],
    // Asked for, but home has no stream to show.
    ["home", true, true, 1, false],
    // Asked for, not home, and nothing to stream about yet.
    ["nothing to stream about yet", true, false, 0, false],
    ["not asked for", false, false, 1, false],
  ])("%s", (_case, asked, home, count, shown) => {
    expect(showSide(asked, home, count)).toBe(shown);
  });
});

test("every view that owns its scrolling is in the list that says so", () => {
  // The rule is a membership list, which is the shape that drifts: a view added
  // to `VIEWS` and not to `scrollClass` gets the page's scrollbar instead of its
  // own, and the symptom is a double scrollbar nobody traces back to here.
  const owns = ["cost", "owns", "desk", "notes", "progress"] as const;
  for (const view of owns) expect(scrollClass(view)).toContain("overflow-hidden");
  expect(scrollClass("home")).toContain("overflow-y-auto");
  // `req` is not in `VIEWS` — it is reached from a list rather than the strip —
  // and it scrolls like the list it came from.
  expect(scrollClass("req")).toContain("overflow-hidden");
  // Stated as a set difference so a new view has to be classified on purpose:
  // whoever adds one to the strip has to decide which half it belongs to.
  const unclassified = VIEWS.map(([view]) => view).filter(
    (view) => !scrollClass(view).includes("overflow-hidden") && view !== "home",
  );
  expect(unclassified).toEqual([]);
});

test("settings opens where it was asked to, then where it was left, then at credentials", () => {
  expect(settingsInitial("github", "gates")).toBe("github");
  expect(settingsInitial(null, "gates")).toBe("gates");
  expect(settingsInitial(null, null)).toBe("cred");
});

test("a group names its own project, and the fallback only fills a gap", () => {
  // The selected project follows the requirement being opened, or a requirement
  // opened from a link shows one project's page while displaying another's work.
  expect(projectForGroup({ project_id: 7 }, 3)).toBe(7);
  expect(projectForGroup(undefined, 3)).toBe(3);
  expect(projectForGroup(undefined, null)).toBeNull();
});

test("the small selectors answer for absent input rather than throwing", () => {
  expect(findById(2, [{ id: 1 }, { id: 2 }])).toEqual({ id: 2 });
  expect(findById(9, [{ id: 1 }])).toBeUndefined();
  expect(findById(null, [{ id: 1 }])).toBeUndefined();
  expect(waitingProject(true, 4)).toBeNull();
  expect(waitingProject(false, 4)).toBe(4);
});

describe("a crumb and a button each need every one of their conditions", () => {
  test.each([
    ["on the requirement with one to name", "req", true, true],
    ["on the requirement with nothing to name", "req", false, false],
    ["on the list", "progress", true, false],
  ] as const)("the requirement crumb: %s", (_case, view, hasGroup, shown) => {
    expect(showRequirementCrumb(view, hasGroup)).toBe(shown);
  });

  // A project is needed, and so is a project list — the button writes into one.
  test.each([
    ["a project and a list to write into", 1, 1, true],
    ["no project selected", null, 1, false],
    ["no project list", 1, 0, false],
  ])("the new-requirement button: %s", (_case, projectId, projects, shown) => {
    expect(showNewRequirement(projectId, projects)).toBe(shown);
  });
});
