import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Plural, Trans } from "@lingui/react/macro";
import { Button } from "../ui/button";
import type { HostFailure } from "../shared/api";

/**
 * A broken host check, said once, where the boss is looking.
 *
 * This replaces a `consola.warn` in the readiness timer: a terminal nobody
 * watches, re-printed every tick for as long as the fault lasted. The finding
 * rides the snapshot the panel already polls, so there is no new request and no
 * new hook — only the decision of when it is worth interrupting for, and what it
 * has to say when it does.
 */

/**
 * One toast, whatever the count.
 *
 * Faults arrive in groups — a docker daemon that is down takes the sandbox
 * server and the image check with it — and three stacked toasts in the corner
 * cover the board this panel exists to show. A fixed id makes sonner replace
 * rather than stack (2.0.8 merges a toast whose id is already on screen), so
 * three failures are one surface with three rows, and the count is in the title
 * where it is read first.
 */
const ID = "preflight";

/**
 * Rows before it stops listing. Preflight can raise eight checks at once, and a
 * toast tall enough for eight is a dialog nobody asked for. Three names and the
 * count of the rest is enough to decide, and the button goes where all of them
 * are.
 */
const ROWS = 3;

/**
 * What is worth interrupting for is the *transition*, not the state: the
 * snapshot arrives on a 60s poll and again on every stream frame, so notifying
 * on what it says would raise the same toast a hundred times an hour. The whole
 * failing set is fingerprinted, so a check going bad, a detail moving, or one of
 * three recovering are each news exactly once.
 */
/**
 * A ref, not state: nothing renders from it, and re-rendering on it would re-run
 * the effect that wrote it. Sonner's `id` alone cannot do this job — a toast the
 * boss dismissed is gone, and the next poll would raise it again, which is the
 * nagging this exists to prevent.
 */
export function useHostAlerts(failing: readonly HostFailure[], onFix: () => void): void {
  const said = useRef("");
  useEffect(() => {
    const now = failing.map((check) => `${check.name}\u0000${check.detail}`).join("\u001f");
    if (now === said.current) return;
    said.current = now;
    // The host is well again. Taken down rather than left to expire, because
    // this toast does not expire — an error still on screen after the fault is
    // gone is worse than never having raised it.
    if (!failing.length) return void toast.dismiss(ID);
    const first = failing[0];
    toast.error(
      failing.length === 1 && first ? (
        <Trans>Host check failed: {first.name}</Trans>
      ) : (
        <Plural value={failing.length} one="# host check failed" other="# host checks failed" />
      ),
      {
        id: ID,
        // Named only when the title cannot be. One fault puts the check's name
        // in the title, and repeating it on the row underneath is a word the
        // boss reads twice to learn one thing.
        description: <Failures checks={failing} named={failing.length > 1} />,
        // Where all of them are, with their own controls. The boss's next move
        // after reading this is that pane, and making them find it is the
        // difference between a notification and a nag.
        action: (
          <Button
            size="sm"
            onClick={() => {
              toast.dismiss(ID);
              onFix();
            }}
          >
            <Trans>Fix in settings</Trans>
          </Button>
        ),
        // It stays until dismissed or fixed. The fault does: a host with no
        // Docker still has none in five seconds, and the fix is a command to
        // read and type, which cannot be done from a toast that has gone.
        // `Infinity` is sonner's own switch for this — it special-cases the
        // value, where `setTimeout` would treat the delay as zero.
        duration: Number.POSITIVE_INFINITY,
        closeButton: true,
      },
    );
  }, [failing, onFix]);
}

/**
 * Three things per row, in the order they are acted on: which check, what it
 * says, what to type. `detail` and `fix` are two different sentences — one names
 * the fault, one is an instruction — so `fix` gets its own line and the panel's
 * code treatment rather than being run on into the prose. Deliberately the same
 * treatment as the settings pane's own check list: the boss should recognise the
 * second surface as the first.
 */
/**
 * Both strings are server-authored and rendered as text. Neither goes near a
 * catalog; only the frame around them is translated.
 */
function Failures({ checks, named }: { checks: readonly HostFailure[]; named: boolean }) {
  return (
    <div className="mt-1 flex flex-col gap-2">
      {checks.slice(0, ROWS).map((check) => (
        <div key={check.name} className="flex flex-col gap-1">
          <div className="leading-snug">
            {named ? <span className="font-medium text-ink">{check.name} </span> : null}
            <span className="text-ink-3">{check.detail}</span>
          </div>
          {check.fix ? (
            <span className="rounded-md bg-sunk px-2 py-1 font-mono text-meta leading-relaxed text-ink-2">
              {check.fix}
            </span>
          ) : null}
        </div>
      ))}
      {checks.length > ROWS ? (
        <span className="text-ink-3 text-meta">
          <Plural value={checks.length - ROWS} one="and # more" other="and # more" />
        </span>
      ) : null}
    </div>
  );
}
