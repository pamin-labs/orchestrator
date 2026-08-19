import { Component, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Card, CardBody, CardTitle } from "../ui/card";
import i18n from "../i18n";

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
          <CardTitle className="text-bad">{i18n.t("app.boundary.title", "这个视图崩了")}</CardTitle>
          <div className="mt-1 text-[0.75rem] text-ink-2">
            {i18n.t("app.boundary.hint", "界面和服务端版本可能不一致。重启服务（")}
            <span className="font-mono">bun run dev</span>
            {i18n.t("app.boundary.hintSuffix", "）会重建前端。")}
          </div>
          <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-sunk p-2 font-mono text-[0.6875rem] text-ink-2">
            {err.message}
          </pre>
          <div className="mt-3 flex gap-1.5">
            <Button variant="go" onClick={() => location.reload()}>
              {i18n.t("app.boundary.refresh", "刷新")}
            </Button>
            <Button onClick={() => this.setState({ err: null })}>
              {i18n.t("app.boundary.retry", "重试这个视图")}
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }
}
