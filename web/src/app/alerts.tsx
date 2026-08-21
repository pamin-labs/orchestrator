import { useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import type { HostFailure } from "../shared/api";
import { saidText } from "../shared/said";

/**
 * A broken host check, stated where the boss is looking.
 *
 * This replaces a `consola.warn` in the readiness timer: a terminal nobody
 * watches, re-printed every tick for as long as the fault lasted. The finding
 * rides the snapshot the panel already polls, so there is no new request and no
 * new hook.
 */
/**
 * One row in the shell, not a toast, and that is the whole design.
 *
 * The first version stacked every failure with its `fix` paragraph into a
 * floating toast: 700px of overlay, in the corner, covering the board this panel
 * exists to show.
 */
/**
 * Two things were wrong with it. A toast reports an event and leaves; a broken
 * host check is a state that holds until somebody fixes it. And the details were
 * already on screen — the Environment pane renders every check with its
 * `detail` and `fix`, so the overlay was a worse copy of the surface its own
 * button points at.
 */

/**
 * What is worth interrupting for is the *transition*, not the state: the
 * snapshot arrives on a 60s poll and again on every stream frame, so keying the
 * banner off what it says would revive a dismissed one a hundred times an hour.
 */
/**
 * The whole failing set is fingerprinted, so a check going bad, a detail moving,
 * or one of three recovering are each news exactly once, and dismissing holds
 * until the set itself changes.
 */
const fingerprint = (failing: readonly HostFailure[]): string =>
  failing.map((check) => `${check.name}\u0000${check.detail}`).join("\u001f");

export function HostAlert({ failing, onFix }: { failing: readonly HostFailure[]; onFix: () => void }) {
  const { t } = useLingui();
  // Dismissal stores the fingerprint it dismissed, so the banner comes back by
  // itself the moment the set of failures is a different set — no effect, no
  // second source of truth for what is on screen.
  const [hidden, setHidden] = useState("");
  const now = fingerprint(failing);

  const first = failing[0];
  if (!first || hidden === now) return null;

  return (
    <Alert>
      <TriangleAlert size={14} strokeWidth={2} className="text-bad" aria-hidden />
      <span className="flex min-w-0 items-baseline gap-2">
        <AlertTitle>
          <Plural value={failing.length} one="# host check failed" other="# host checks failed" />
        </AlertTitle>
        {/* The name belongs to the sentence, not to the title. A `detail` is
            written to follow its own name — `opensandbox-server` + `server
            requires an API key and none was sent` — so dropping the name left
            the row starting mid-phrase, which is how the settings pane renders
            the same pair. The name is an identifier and stays as it is; the
            sentence after it is a key the panel renders, and falls back to the
            server's English for a key this build has never heard of. */}
        <AlertDescription>
          <span className="text-ink">{first.name}</span> {saidText(first.said, first.detail)}
        </AlertDescription>
      </span>
      <AlertAction>
        <Button size="sm" variant="quiet" onClick={onFix}>
          <Trans>Fix in settings</Trans>
        </Button>
        <button
          type="button"
          aria-label={t`Dismiss`}
          onClick={() => setHidden(now)}
          className="grid size-6 cursor-pointer place-items-center rounded-md text-ink-3 transition-colors hover:bg-bad-soft hover:text-ink"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </AlertAction>
    </Alert>
  );
}
