import { expect, test } from "bun:test";
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

test("a requirement keeps its project's tab lit", () => {
  // `req` is reached from `progress` and is not a sibling of it, so the strip
  // has to keep showing where the reader came from — otherwise opening a
  // requirement makes the whole navigation look unselected.
  expect(viewActive("req", "progress")).toBe(true);
  expect(viewActive("progress", "progress")).toBe(true);
  expect(viewActive("req", "notes")).toBe(false);
  // Not symmetric: being on the list does not light the requirement.
  expect(viewActive("progress", "req")).toBe(false);
});

test("no project is home, whatever the hash asked for", () => {
  // A link into 记录 on a machine with no project has nowhere to land, and the
  // fallback has to happen here rather than at each view.
  expect(isHome("notes", false)).toBe(true);
  expect(isHome("home", true)).toBe(true);
  expect(isHome("notes", true)).toBe(false);
});

test("the event stream needs all three of its conditions", () => {
  expect(showSide(true, false, 1)).toBe(true);
  // Asked for, but home has no stream to show.
  expect(showSide(true, true, 1)).toBe(false);
  // Asked for, not home, and nothing to stream about yet.
  expect(showSide(true, false, 0)).toBe(false);
  expect(showSide(false, false, 1)).toBe(false);
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
  expect(showRequirementCrumb("req", true)).toBe(true);
  expect(showRequirementCrumb("req", false)).toBe(false);
  expect(showRequirementCrumb("progress", true)).toBe(false);
  // A project is needed, and so is a project list — the button writes into one.
  expect(showNewRequirement(1, 1)).toBe(true);
  expect(showNewRequirement(null, 1)).toBe(false);
  expect(showNewRequirement(1, 0)).toBe(false);
});
