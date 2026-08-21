import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render } from "../support/render.tsx";
import { HostAlert } from "../../web/src/app/alerts.tsx";
import type { HostFailure } from "../../web/src/shared/api.ts";

/**
 * A broken host check states itself in the shell, once, without covering it.
 *
 * The snapshot carrying it arrives on a 60s poll *and* on every stream frame.
 * The first version of this was a toast, which made every one of those arrivals
 * a decision about whether to interrupt; a banner is declarative, so what has to
 * be asserted instead is that dismissing it holds — and that it comes back by
 * itself when the set of faults is a different set.
 */

const docker = (detail: string): HostFailure => ({ name: "docker", detail, fix: "colima start" });
const server = (detail: string): HostFailure => ({ name: "sandbox-server", detail });

afterEach(cleanup);

test("a broken check names itself and says what is wrong", () => {
  const { getByRole } = render(<HostAlert failing={[docker("daemon is not running")]} onFix={() => {}} />);
  // Server-authored, rendered as text. `role="alert"` because that is what this
  // is to a screen reader, and it is how the row is found without a test id.
  expect(getByRole("alert").textContent).toContain("daemon is not running");
  expect(getByRole("alert").textContent).toContain("docker");
});

// A count, never the node: a failing `expect(element)` prints the whole
// document and turns a one-line diff into a screenful.
test("a healthy host draws nothing at all", () => {
  const { queryAllByRole } = render(<HostAlert failing={[]} onFix={() => {}} />);
  expect(queryAllByRole("alert").length).toBe(0);
});

/**
 * Faults arrive in groups — a dead docker takes the sandbox server and the image
 * check with it — and the failure this guards is the one the toast had: every
 * fault, with its instructions, stacked into a box tall enough to cover the
 * board. One row, the count in the title, the rest behind the button.
 */
test("three faults are one row with the count, not three rows", () => {
  const { getByRole } = render(
    <HostAlert
      failing={[docker("daemon is not running"), server("HTTP 500"), { name: "image", detail: "no registry" }]}
      onFix={() => {}}
    />,
  );
  const said = getByRole("alert").textContent ?? "";
  expect(said).toContain("3");
  // Only the first fault's detail. The other two are in the pane the button
  // opens, which renders each with its own `fix`.
  expect(said).toContain("daemon is not running");
  expect(said).not.toContain("HTTP 500");
  expect(said).not.toContain("no registry");
});

/**
 * `fix` is a paragraph of instructions — "Settings → Claude → sign in. It runs
 * the official claude setup-token inside the utility container…" — and four of
 * them is what made the first version 700px of overlay. It belongs on the pane
 * that has room for it.
 */
test("the instructions stay in the pane that has room for them", () => {
  const { getByRole } = render(<HostAlert failing={[docker("daemon is not running")]} onFix={() => {}} />);
  expect(getByRole("alert").textContent).not.toContain("colima start");
});

/**
 * By what it is, not by what it says: the suite runs under the Chinese catalog,
 * so matching the label would assert on a translation and go red the day
 * somebody rewords it. The dismiss control is the one with an `aria-label`,
 * which leaves exactly one other button in the row.
 */
test("the button offers the pane where all of them are fixed", () => {
  const onFix = mock(() => {});
  const { getAllByRole } = render(<HostAlert failing={[docker("daemon is not running")]} onFix={onFix} />);
  const fix = getAllByRole("button").filter((b) => !b.getAttribute("aria-label"));
  expect(fix).toHaveLength(1);
  fix[0]?.click();
  expect(onFix).toHaveBeenCalledTimes(1);
});

/**
 * The pair that replaces the toast's fingerprint. Dismissing has to survive the
 * next poll — otherwise the banner is a nag with an X on it — and it has to stop
 * surviving the moment the faults are different ones, or a dismissal silences a
 * fault the boss has never seen.
 */
test("a dismissed banner stays dismissed across the polls that follow", () => {
  const { getAllByRole, queryAllByRole, rerender } = render(
    <HostAlert failing={[docker("daemon is not running")]} onFix={() => {}} />,
  );
  getAllByRole("button").at(-1)?.click();
  // A fresh array each time, which is what react-query hands over: identity is
  // not what keeps this quiet, the remembered fingerprint is.
  for (let poll = 0; poll < 5; poll++) {
    rerender(<HostAlert failing={[docker("daemon is not running")]} onFix={() => {}} />);
  }
  expect(queryAllByRole("alert").length).toBe(0);
});

test("a dismissed banner returns when the faults are different faults", () => {
  const { getAllByRole, getByRole, queryAllByRole, rerender } = render(
    <HostAlert failing={[docker("daemon is not running")]} onFix={() => {}} />,
  );
  getAllByRole("button").at(-1)?.click();
  // The rerender is what flushes the click's state update, which is also the
  // shape the real thing has: the next poll is what re-renders this.
  rerender(<HostAlert failing={[docker("daemon is not running")]} onFix={() => {}} />);
  expect(queryAllByRole("alert").length).toBe(0);
  rerender(<HostAlert failing={[docker("permission denied on the socket")]} onFix={() => {}} />);
  expect(getByRole("alert").textContent).toContain("permission denied on the socket");
});
