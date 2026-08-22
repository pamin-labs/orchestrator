import { expect, test } from "bun:test";
import {
  backgroundView,
  connectionText,
  contentKey,
  contentSlot,
  navigationShortcut,
  parseSelection,
  projectItem,
  readSide,
  repairMissingGroup,
  resolveNavigation,
  selectionHash,
  sideText,
  showNewRequirement,
  showRequirementCrumb,
  type Selection,
} from "../../web/src/features/navigation/model.ts";

const selection = (patch: Partial<Selection> = {}): Selection => ({
  p: 7,
  view: "progress",
  g: null,
  t: "live",
  s: null,
  ...patch,
});

test("hash and legacy navigation retain drill-in and dialog behavior", () => {
  const parsed = parseSelection("#p=7&v=progress&g=11&t=live&s=skills");
  expect(selectionHash(parsed)).toBe("#p=7&v=progress&g=11&t=live&s=skills");
  expect(resolveNavigation(parsed, "desk")).toEqual({ section: null, view: "req" });
  expect(resolveNavigation(selection({ view: "config" }), "desk")).toEqual({ section: "gates", view: "desk" });
  expect(backgroundView(selection({ view: "settings" }))).toBeNull();
  expect(contentSlot(1, false, "progress", 0, false, false)).toBe("empty");
  expect(contentSlot(1, false, "req", 0, false, false)).toBe("missing");
  expect(repairMissingGroup(11, [10, 12])).toEqual({ g: null, view: "progress", t: null });
});

test("keyboard, labels and switcher rows preserve visible policy", () => {
  const key = (value: string, extra = {}) => ({ altKey: false, ctrlKey: false, metaKey: true, key: value, ...extra });
  expect(navigationShortcut(key("b"), selection())).toBe("toggle-side");
  expect(navigationShortcut(key("k"), selection({ view: "req", g: 11 }))).toBe("requirement-picker");
  expect(navigationShortcut(key("k", { altKey: true }), selection())).toBeNull();
  expect(connectionText("retry")).toBe("连接断了，重连中");
  expect(sideText(false)).toContain("展开事件流");
  expect(showRequirementCrumb("req", true)).toBeTrue();
  expect(showNewRequirement(7, 1)).toBeTrue();
  expect(projectItem({ id: 1, name: "repo", repo_path: "owner/repo", remote: null, base_branch: null }, 2)).toEqual({
    id: 1,
    name: "owner/repo",
    rtlMeta: true,
    badge: "2 件待办",
  });
  expect(readSide({ getItem: () => "0" })).toBeFalse();
});

test("a dialog does not change the identity of the page behind it", () => {
  // `contentKey` feeds the error boundary's `key`, and a `key` change unmounts
  // and remounts the whole subtree. It used to be built from `selection.view`,
  // which becomes `settings` the instant a dialog opens — so opening `Settings` threw
  // away the page underneath and rebuilt it. On `Time` both charts and the table
  // disappeared and came back as the modal appeared, each one re-reading the
  // endpoint on the way. The resolved view is what stays put.
  const behind = resolveNavigation(selection({ view: "settings", p: 1 }), "time");
  expect(behind.view).toBe("time");
  expect(contentKey(behind.view, 1, null)).toBe(contentKey("time", 1, null));

  // A real page change still changes it, or the boundary would keep showing one
  // requirement's error while displaying the next.
  expect(contentKey("time", 1, null)).not.toBe(contentKey("time", 2, null));
  expect(contentKey("time", 1, null)).not.toBe(contentKey("progress", 1, null));
});
