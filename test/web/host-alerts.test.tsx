import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Toaster, toast } from "sonner";
import { cleanup, render, waitFor } from "../support/render.tsx";
import { useHostAlerts } from "../../web/src/app/alerts.tsx";
import type { HostFailure } from "../../web/src/shared/api.ts";

/**
 * The panel is told about a broken host check, once, on one surface.
 *
 * The snapshot carrying it arrives on a 60s poll *and* on every stream frame, so
 * the naive version of this raises the same toast every time an agent says
 * anything. What is worth interrupting for is the transition — a check that has
 * gone bad, one whose detail moved, or one that came back — which is what these
 * assert, along with the two things that keep the corner of the screen usable:
 * one toast for any number of faults, and no toast once the host is well.
 */

/** Nothing is rendered; the hook is the unit, and the toast is the observable. */
function Harness({ failing }: { failing: HostFailure[] }) {
  useHostAlerts(failing, () => {});
  return null;
}

const raised = () => spyOn(toast, "error").mockImplementation(() => "");

const docker = (detail: string): HostFailure => ({ name: "docker", detail, fix: "colima start" });
const server = (detail: string): HostFailure => ({ name: "sandbox-server", detail });

afterEach(() => {
  cleanup();
  toast.dismiss();
  // In `afterEach` and not at the end of each test: a failing assertion throws
  // past a restore written after it, and the next test then counts calls the
  // previous one made.
  mock.restore();
});

test("a check that has gone bad raises a notification", () => {
  const said = raised();
  render(<Harness failing={[docker("daemon is not running")]} />);
  expect(said).toHaveBeenCalledTimes(1);
  expect(said.mock.calls[0]?.[1]?.id).toBe("preflight");
});

test("the same failure arriving on every poll is not raised again", () => {
  const said = raised();
  const { rerender } = render(<Harness failing={[docker("daemon is not running")]} />);
  // A fresh array each time, which is what react-query hands over: identity is
  // not what makes this quiet, the remembered fingerprint is.
  for (let poll = 0; poll < 5; poll++) rerender(<Harness failing={[docker("daemon is not running")]} />);
  expect(said).toHaveBeenCalledTimes(1);
});

test("a failure that changes underneath is news again", () => {
  const said = raised();
  const { rerender } = render(<Harness failing={[docker("daemon is not running")]} />);
  rerender(<Harness failing={[docker("permission denied on the socket")]} />);
  expect(said).toHaveBeenCalledTimes(2);
});

/**
 * The one that decides whether the corner of the screen stays usable. Faults
 * arrive in groups — a dead docker takes the sandbox server with it — and the
 * failure mode being guarded is three stacked toasts over the board.
 */
test("three faults are one toast, not three", () => {
  const said = raised();
  render(
    <Harness
      failing={[docker("daemon is not running"), server("HTTP 500"), { name: "image", detail: "no registry" }]}
    />,
  );
  expect(said).toHaveBeenCalledTimes(1);
  // Sonner replaces a toast whose id is already on screen, so one id is what
  // makes "one surface" true however many times this is raised.
  expect(said.mock.calls[0]?.[1]?.id).toBe("preflight");
});

/**
 * The toast never expires, so nothing but this takes it down. An error still on
 * screen after the host recovered is worse than never having raised it.
 */
test("a host that recovers takes its toast with it", () => {
  const gone = spyOn(toast, "dismiss").mockImplementation(() => "");
  const { rerender } = render(<Harness failing={[docker("daemon is not running")]} />);
  expect(gone).not.toHaveBeenCalled();
  rerender(<Harness failing={[]} />);
  expect(gone).toHaveBeenCalledWith("preflight");
});

test("a check that recovers and breaks again is raised again, not swallowed", () => {
  const said = raised();
  const { rerender } = render(<Harness failing={[docker("daemon is not running")]} />);
  rerender(<Harness failing={[]} />);
  rerender(<Harness failing={[docker("daemon is not running")]} />);
  expect(said).toHaveBeenCalledTimes(2);
});

/**
 * The one test that draws it.
 *
 * Every assertion above mocks `toast.error`, which means the description and the
 * button are constructed and thrown away — a `<Plural>` that will not compile
 * inside a toast, or a broken import, keeps all six green. This one mounts the
 * real `<Toaster>` and reads the result.
 */
/**
 * The three strings the boss acts on have to survive the trip: which check, what
 * it says, what to type. `fix` is its own element rather than run into the
 * sentence — that is the whole point of having two fields.
 */
test("the toast draws what to fix and how, and offers the pane that fixes it", async () => {
  const onFix = mock(() => {});
  function Drawn() {
    useHostAlerts([docker("daemon is not running")], onFix);
    return null;
  }
  const { findByText, getAllByRole } = render(
    <>
      <Toaster />
      <Drawn />
    </>,
  );

  // Server-authored, both of them, and both present: `detail` names the fault,
  // `fix` is the command. Found separately because they are drawn separately.
  expect((await findByText("daemon is not running")).tagName).toBe("SPAN");
  expect((await findByText("colima start")).tagName).toBe("SPAN");
  // Once, not twice: one fault names the check in the title, so the row below it
  // carries only what the title cannot say.
  expect((await findByText(/docker/)).textContent).toBe("Host check failed: docker");

  // English: the frame is a new msgid and no catalog carries it yet, so Lingui
  // falls back to the source string. The assertion is on the button existing and
  // calling back, not on which language it settles in.
  const fix = getAllByRole("button").filter((b) => b.textContent?.includes("Fix in settings"));
  expect(fix).toHaveLength(1);
  fix[0]?.click();
  await waitFor(() => expect(onFix).toHaveBeenCalledTimes(1));
});
