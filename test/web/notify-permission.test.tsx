import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render } from "../support/render.tsx";
import { Permission } from "../../web/src/features/knobs/editors.tsx";

/**
 * Two rows for two facts, and which of them is drawn depends on a browser API
 * this pane cannot control.
 *
 * The permission row says one of four things — unsupported, granted, denied, or
 * a button — and the switch below it exists only once the browser has agreed,
 * because before that it would control something that cannot happen.
 */

const notification = (permission: NotificationPermission | null) => {
  const holder = globalThis as { Notification?: unknown };
  if (permission === null) delete holder.Notification;
  else holder.Notification = { permission, requestPermission: () => Promise.resolve(permission) };
};

beforeEach(() => notification("default"));
afterEach(() => {
  cleanup();
  notification(null);
});

test("a browser that has not been asked is offered the button, not a sentence", () => {
  const { getByRole, queryAllByRole } = render(<Permission />);
  expect(getByRole("button").textContent).toBe("允许通知");
  // The switch is not drawn: it would be a control over something that cannot
  // happen until the browser agrees.
  expect(queryAllByRole("switch")).toHaveLength(0);
});

test("a granted permission says so and brings the switch with it", () => {
  notification("granted");
  const { queryAllByRole, getByText } = render(<Permission />);
  expect(queryAllByRole("switch")).toHaveLength(1);
  expect(getByText(/浏览器已放行/).tagName).toBe("SPAN");
});

test("a denied permission explains where to change it, and offers no button", () => {
  notification("denied");
  const { queryAllByRole, getByText } = render(<Permission />);
  expect(queryAllByRole("button")).toHaveLength(0);
  expect(getByText(/被浏览器拒了/).tagName).toBe("SPAN");
});

/** A browser with no Notification at all — the one state that is not about the
 *  boss's choice, so it says so rather than offering a control. */
test("a browser without notifications says that, rather than offering a dead button", () => {
  notification(null);
  const { queryAllByRole, getByText } = render(<Permission />);
  expect(queryAllByRole("button")).toHaveLength(0);
  expect(getByText(/不支持/).tagName).toBe("SPAN");
});
