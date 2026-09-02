import { describe, expect, test } from "bun:test";
import {
  backgroundView,
  contentSlot,
  findById,
  isHome,
  navigationShortcut,
  nextSelection,
  repairMissingGroup,
  repairMissingProject,
  repairSelection,
  projectForGroup,
  scrollClass,
  type Selection,
  selectionHash,
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
 * A link into `Notes` on a machine with no project has nowhere to land, and the
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

/**
 * A requirement that has been delivered leaves no live group behind, so the
 * requirements page counted zero and drew the first-run onboarding panel over a
 * project with a shipped history. "Nothing running" and "nothing ever" are the
 * same number and different pages.
 */
describe("a delivered requirement is history, not an empty project", () => {
  test.each([
    ["work in flight", 2, false, "progress"],
    ["nothing running but something delivered", 0, true, "progress"],
    ["neither", 0, false, "empty"],
  ] as const)("%s", (_case, groups, delivered, slot) => {
    expect(contentSlot(1, false, "progress", groups, delivered, false)).toBe(slot);
  });
});

/**
 * `req` is the drill-in, and it is only reachable with a requirement to draw.
 * Behind a dialog opened from the bare list, resolving to `req` anyway asks the
 * page for a requirement nobody selected — a blank pane behind the modal, and a
 * remount of it when the modal closes.
 */
test("the page behind a dialog is the list until a requirement is picked", () => {
  expect(backgroundView({ view: "progress", g: null })).toBe("progress");
  expect(backgroundView({ view: "progress", g: 11 })).toBe("req");
  // `board` is the old name for the list, and it drills in on the same rule.
  expect(backgroundView({ view: "board", g: null })).toBe("progress");
});

/**
 * The requirement list arrives after the hash does. An empty list is "the state
 * has not loaded yet", not "that requirement is gone" — repairing on it threw
 * away the requirement in the URL on every cold load of a deep link.
 */
test("an empty requirement list is not yet loaded, not a missing requirement", () => {
  expect(repairMissingGroup(11, [])).toBeNull();
  expect(repairMissingGroup(11, [10, 12])).toEqual({ g: null, view: "progress", t: null });
  expect(repairMissingGroup(11, [11])).toBeNull();
  expect(repairMissingGroup(null, [10])).toBeNull();
});

/**
 * The project in the hash, against a database that no longer has it.
 *
 * A new server on the same address is a browser still holding `#p=` from the old
 * one, and nothing checked. The id reached `SettingsDialog`, the only consumer
 * that takes `sel.p` without the existence check the rest of the shell applies,
 * which asked for its config on every window focus and got a 404 each time.
 */
/**
 * `loaded` rather than the group rule's `ids.length === 0`: for projects an
 * empty list is also a real state (a fresh install), so emptiness cannot stand
 * in for "the snapshot has not arrived".
 */
test("a project that is not in the snapshot is dropped, but only once the snapshot is in", () => {
  expect(repairMissingProject(9, [1, 2], true)).toEqual({ p: null, g: null, view: "home", t: null });
  // Loaded and genuinely empty — a first boot with a stale link still repairs.
  expect(repairMissingProject(9, [], true)).toEqual({ p: null, g: null, view: "home", t: null });
  // Not loaded: identical arguments, opposite answer. This is the cold-load case
  // that made the group rule read an empty list as "not yet".
  expect(repairMissingProject(9, [], false)).toBeNull();
  expect(repairMissingProject(9, [9], true)).toBeNull();
  expect(repairMissingProject(null, [1], true)).toBeNull();
});

/**
 * Both rules, asked once, and the project answers first.
 *
 * A hash from a previous database names a project *and* a requirement, and both
 * are gone. Running the group rule as well would compute a second repair for a
 * question the first one already settled — the project repair clears `g` itself.
 */
test("dropping a project that is gone also settles the requirement under it", () => {
  const ids = { groups: [7], projects: [1] };
  expect(repairSelection({ p: 9, g: 8 }, ids, true)).toEqual({ p: null, g: null, view: "home", t: null });
  // Project fine, requirement gone: the group rule still gets its turn.
  expect(repairSelection({ p: 1, g: 8 }, ids, true)).toEqual({ g: null, view: "progress", t: null });
  expect(repairSelection({ p: 1, g: 7 }, ids, true)).toBeNull();
});

/**
 * ⌘K on a requirement offers to jump between requirements; anywhere else it
 * offers projects. On `req` with nothing selected there are no requirements to
 * list, so the picker opens empty and the one key that always works stops.
 */
describe("⌘K opens the picker that has something in it", () => {
  const press = (key: string, view: "req" | "progress", g: number | null) =>
    navigationShortcut({ key, metaKey: true, ctrlKey: false, altKey: false }, { view, g });

  test.each([
    ["on a requirement", "req", 11, "requirement-picker"],
    ["on the list", "progress", null, "project-picker"],
    ["on req before one is selected", "req", null, "project-picker"],
  ] as const)("%s", (_case, view, g, shortcut) => {
    expect(press("k", view, g)).toBe(shortcut);
  });
});

/**
 * A tab belongs to the view it was opened in.
 *
 * `t` is a tab *within* a view, and it used to survive every navigation: the
 * host banner's "fix this" landed on `#v=settings&t=done&s=server`, naming a tab
 * the settings view does not have. The rule is in the model rather than at each
 * caller because the callers are where it kept being forgotten — the header's
 * own buttons pass `t: null` by hand, and the twenty-fifth one will not.
 */
test("changing view drops the tab the previous view was on", () => {
  const at: Selection = { p: 1, view: "notes", g: null, t: "done", s: null };
  expect(nextSelection(at, { view: "settings", s: "server" }).t).toBeNull();
  // And the hash follows, which is the surface the boss actually reads.
  expect(selectionHash(nextSelection(at, { view: "settings", s: "server" }))).toBe("#p=1&v=settings&s=server");
});

test("staying on a view keeps its tab, and an explicit tab still wins", () => {
  const at: Selection = { p: 1, view: "notes", g: null, t: "done", s: null };
  // Same view, so nothing about the tab was said and nothing changes.
  expect(nextSelection(at, { p: 2 }).t).toBe("done");
  // A patch that names the tab is applied last, so a caller can still land on
  // one deliberately — which is what the header's own buttons do.
  expect(nextSelection(at, { view: "req", t: "held" }).t).toBe("held");
});
