import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "../support/render.tsx";
import { Embedding } from "../../web/src/features/knobs/editors.tsx";

afterEach(cleanup);

/**
 * Local or remote is one row with the model, because it is one decision.
 *
 * Split across two rows it invites `remote` with `Xenova/multilingual-e5-small`
 * still in the box, which fails at the first call to an endpoint that has never
 * heard of that name — and fails there rather than here, an hour later, as an
 * HTTP error about a model.
 *
 * The suggestions are the point of the local half: ADR 031 measured two of these
 * names and named the third, and none of them is a string anybody types
 * correctly from memory.
 */
const row = (mode: string) => {
  const writes: Record<string, string> = {};
  const view = render(
    <Embedding
      mode={mode}
      model={mode === "local" ? "Xenova/multilingual-e5-small" : "text-embedding-3-large"}
      onMode={(v) => (writes.mode = v)}
      onModel={(v) => (writes.model = v)}
    />,
  );
  return { view, writes };
};

test("local offers the measured models as suggestions", () => {
  const { view } = row("local");
  fireEvent.click(view.getAllByRole("combobox")[0]!);
  const names = view.getAllByRole("option").map((o) => o.textContent);
  expect(names).toContain("Xenova/multilingual-e5-base");
  expect(names).toContain("BAAI/bge-m3");
});

test("remote suggests nothing, because the endpoint's model names are not ours to guess", () => {
  const { view } = row("remote");
  fireEvent.click(view.getAllByRole("combobox")[0]!);
  expect(view.queryAllByRole("option").map((o) => o.textContent)).not.toContain("BAAI/bge-m3");
});

test("switching to remote writes the mode and leaves the model to the next keystroke", () => {
  const { view, writes } = row("local");
  fireEvent.click(view.getAllByRole("radio", { name: "远程" })[0]!);
  expect(writes.mode).toBe("remote");
  // Not cleared for the boss: a mode switch that wiped the box would lose a model
  // name somebody had just pasted in to compare against.
  expect(writes.model).toBeUndefined();
});
