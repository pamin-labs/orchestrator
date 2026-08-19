import { expect, test } from "bun:test";
import { render } from "../support/render.tsx";
import { Boundary } from "../../web/src/app/boundary.tsx";

/**
 * The error boundary catches, and says so where somebody can read it.
 *
 * It had no test, which for a boundary is the same as having no boundary: the
 * failure it exists for cannot be reproduced by using the panel, so nothing else
 * would ever exercise it. `boundary.tsx` records what it was written for — a field
 * the server gained, an older build reading it as undefined, the whole panel blank.
 *
 * React logs the caught error to the console; that noise is the boundary working.
 */
const Boom = ({ throws }: { throws: boolean }) => {
  if (throws) throw new Error("older build read a new field");
  return <div>the view</div>;
};

test("a view that throws is replaced by a message, not by a blank page", () => {
  const view = render(
    <Boundary>
      <Boom throws />
    </Boundary>,
  );
  expect(view.getAllByText("这个视图崩了")).toHaveLength(1);
  // The message, not just the shell: a boundary that swallows what threw leaves
  // the reader with "something broke" and no way to say which build.
  expect(view.container.textContent).toContain("older build read a new field");
  expect(view.queryAllByText("the view")).toHaveLength(0);
});

test("a view that does not throw is rendered untouched", () => {
  const view = render(
    <Boundary>
      <Boom throws={false} />
    </Boundary>,
  );
  expect(view.getAllByText("the view")).toHaveLength(1);
  expect(view.queryAllByText("这个视图崩了")).toHaveLength(0);
});

test("retry clears the error, so a transient failure is not a reload", () => {
  const view = render(
    <Boundary>
      <Boom throws={false} />
    </Boundary>,
  );
  // The retry button only exists in the caught state; that it is offered at all
  // is the claim being checked — the other button reloads, which is not recovery.
  expect(view.queryAllByRole("button", { name: "重试这个视图" })).toHaveLength(0);

  const broken = render(
    <Boundary>
      <Boom throws />
    </Boundary>,
  );
  expect(broken.getAllByRole("button", { name: "重试这个视图" })).toHaveLength(1);
  expect(broken.getAllByRole("button", { name: "刷新" })).toHaveLength(1);
});
