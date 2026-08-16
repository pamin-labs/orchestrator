import { Component, type ReactNode } from "react";
import { Button } from "./button";
import { Card, CardBody, CardTitle } from "./card";

/**
 * One view throwing must not leave a dead page.
 *
 * Measured: the server gained a field, an older build read it as undefined, and
 * the whole panel went blank — which reads as "clicking does nothing", the single
 * most misleading failure this tool can have. A control panel that cannot say
 * "I broke" is worse than one that is wrong out loud.
 */
export class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };

  static getDerivedStateFromError(err: Error) {
    return { err };
  }

  render() {
    const { err } = this.state;
    if (!err) return this.props.children;
    return (
      <Card className="max-w-[44rem]">
        <CardBody>
          <CardTitle className="text-bad">这个视图崩了</CardTitle>
          <div className="mt-1 text-[0.75rem] text-ink-2">
            界面和服务端版本可能不一致。重启服务（<span className="font-mono">bun run dev</span>）会重建前端。
          </div>
          <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-sunk p-2 font-mono text-[0.6875rem] text-ink-2">
            {err.message}
          </pre>
          <div className="mt-3 flex gap-1.5">
            <Button variant="go" onClick={() => location.reload()}>
              刷新
            </Button>
            <Button onClick={() => this.setState({ err: null })}>重试这个视图</Button>
          </div>
        </CardBody>
      </Card>
    );
  }
}
