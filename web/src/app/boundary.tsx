import { Component, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Card, CardBody, CardTitle } from "../ui/card";
import { Trans } from "@lingui/react/macro";

/**
 * One view throwing must not leave a dead page.
 *
 * Measured: the server gained a field, an older build read it as undefined, and
 * the whole panel went blank — which reads as "clicking does nothing", the single
 * most misleading failure this tool can have. A control panel that cannot say
 * "I broke" is worse than one that is wrong out loud.
 */
export class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  override state: { err: Error | null } = { err: null };

  static getDerivedStateFromError(err: Error) {
    return { err };
  }

  override render() {
    const { err } = this.state;
    if (!err) return this.props.children;
    return (
      <Card className="max-w-[44rem]">
        <CardBody>
          <CardTitle className="text-bad">
            <Trans>This view crashed</Trans>
          </CardTitle>
          <div className="mt-1 text-secondary text-ink-2">
            {/* One `<Trans>` around the whole sentence: split at the `<span>`,
                each half extracts as a fragment nobody can reorder. */}
            <Trans>
              Frontend and server versions may be out of sync. Restart the service (
              <span className="font-mono">bun run dev</span>) to rebuild the frontend.
            </Trans>
          </div>
          <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-sunk p-2 font-mono text-meta text-ink-2">
            {err.message}
          </pre>
          <div className="mt-3 flex gap-1.5">
            <Button variant="go" onClick={() => location.reload()}>
              <Trans>Refresh</Trans>
            </Button>
            <Button onClick={() => this.setState({ err: null })}>
              <Trans>Retry this view</Trans>
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }
}
