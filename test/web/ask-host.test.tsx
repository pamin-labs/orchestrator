import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "../support/render.tsx";
import { ask, AskHost } from "../../web/src/ui/confirm.tsx";

afterEach(cleanup);

/**
 * `ask()` always settles, which is the only thing its callers depend on.
 *
 * `AskCard` — the markup — is covered by `diff-confirm-render`. What was not is
 * the plumbing around it: a module-level handle the host installs, and a promise
 * created in one component and resolved from another. A caller that `await`s a
 * question which never settles does not fail, it stops, holding whatever it was
 * doing open — and the failure surfaces as a button that did nothing.
 *
 * The three ways a question can end are three different resolutions and they are
 * easy to get wrong in the same direction: `null` for dismissal, `true` for a
 * plain confirmation, the typed string when there is a field. A confirmation that
 * resolved `true` on dismissal would delete on Escape.
 */
const press = (view: ReturnType<typeof render>, name: string) =>
  fireEvent.click(view.getAllByRole("button", { name })[0]!);

test("confirming resolves true, and dismissing resolves null", async () => {
  const view = render(<AskHost />);

  let yes!: ReturnType<typeof ask>;
  act(() => void (yes = ask({ title: "解散这个需求？" })));
  await waitFor(() => expect(view.getAllByText("解散这个需求？")).toHaveLength(1));
  press(view, "确定");
  expect(await yes).toBe(true);

  let no!: ReturnType<typeof ask>;
  act(() => void (no = ask({ title: "再问一次" })));
  await waitFor(() => expect(view.getAllByText("再问一次")).toHaveLength(1));
  press(view, "取消");
  expect(await no).toBeNull();
});

test("a question with a field resolves the typed text, and an empty one is still text", async () => {
  const view = render(<AskHost />);

  let answered!: ReturnType<typeof ask>;
  act(() => void (answered = ask({ title: "为什么退回", field: "理由" })));
  await waitFor(() => expect(view.getAllByPlaceholderText("理由")).toHaveLength(1));
  fireEvent.change(view.getAllByPlaceholderText("理由")[0]!, {
    target: { value: "验收标准没写清楚" },
  });
  press(view, "确定");
  expect(await answered).toBe("验收标准没写清楚");

  // The empty string, not `true`: a caller reading it as a reason would otherwise
  // store the boolean, and the field's whole purpose is that the answer is text.
  let blank!: ReturnType<typeof ask>;
  act(() => void (blank = ask({ title: "为什么退回", field: "理由" })));
  await waitFor(() => expect(view.getAllByPlaceholderText("理由")).toHaveLength(1));
  press(view, "确定");
  expect(await blank).toBe("");
});

test("the field is cleared between questions, so an answer cannot leak into the next one", async () => {
  const view = render(<AskHost />);

  let first!: ReturnType<typeof ask>;
  act(() => void (first = ask({ title: "第一问", field: "理由" })));
  await waitFor(() => expect(view.getAllByPlaceholderText("理由")).toHaveLength(1));
  fireEvent.change(view.getAllByPlaceholderText("理由")[0]!, {
    target: { value: "第一个理由" },
  });
  press(view, "确定");
  expect(await first).toBe("第一个理由");

  let second!: ReturnType<typeof ask>;
  act(() => void (second = ask({ title: "第二问", field: "理由" })));
  await waitFor(() => expect(view.getAllByPlaceholderText("理由")).toHaveLength(1));
  press(view, "确定");
  expect(await second).toBe("");
});
