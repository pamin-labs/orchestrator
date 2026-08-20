import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "../support/render.tsx";
import { Embedding } from "../../web/src/features/knobs/editors.tsx";

afterEach(cleanup);

/**
 * Local or remote is one row with the model, because it is one decision.
 *
 * Split across two rows it invites `remote` with `Xenova/multilingual-e5-small`
 * still in the box, which fails at the first call to an endpoint that has never
 * heard of that name — an hour later, as an HTTP error about a model.
 *
 * The suggestions are the point of the local half: ADR 031 measured two of these
 * names and named the third, and none is a string anybody types from memory.
 */
/**
 * The endpoint and credential are on this row too, and only under remote.
 *
 * They were rows of their own, drawn as two empty boxes under a segment reading
 * 本地 — fields for a mode nobody had chosen. They cannot be hidden behind the
 * *stored* mode either: `ConfigSchema` refuses `mode: remote` without them and a
 * refused write stores nothing, so the stored mode is still local at exactly the
 * moment somebody needs a box to type in.
 */
const REMOTE = { endpoint: "https://api.example.com/v1/embeddings", credential: "openai" };

const row = (props: Partial<Parameters<typeof Embedding>[0]> = {}) => {
  const writes: Record<string, string> = {};
  const view = render(
    <Embedding
      mode="local"
      model="Xenova/multilingual-e5-small"
      endpoint=""
      credential=""
      onMode={(v) => (writes.mode = v)}
      onField={(path, v) => (writes[path] = v)}
      {...props}
    />,
  );
  return { view, writes };
};

const goRemote = (view: ReturnType<typeof render>) => fireEvent.click(view.getAllByRole("radio", { name: "远程" })[0]!);

test("local offers the measured models as suggestions", () => {
  const { view } = row();
  fireEvent.click(view.getAllByRole("combobox")[0]!);
  const names = view.getAllByRole("option").map((o) => o.textContent);
  expect(names).toContain("Xenova/multilingual-e5-base");
  expect(names).toContain("BAAI/bge-m3");
});

test("remote suggests nothing, because the endpoint's model names are not ours to guess", () => {
  const { view } = row({ mode: "remote", model: "text-embedding-3-large", ...REMOTE });
  fireEvent.click(view.getAllByRole("combobox")[0]!);
  expect(view.queryAllByRole("option").map((o) => o.textContent)).not.toContain("BAAI/bge-m3");
});

test("the address and the credential are hidden until remote is chosen", () => {
  const { view } = row();
  expect(view.queryAllByLabelText("Endpoint")).toHaveLength(0);
  expect(view.queryAllByLabelText("凭据名")).toHaveLength(0);

  // On the press, not on the write: the write is what cannot land yet.
  goRemote(view);
  expect(view.getAllByLabelText("Endpoint")).toHaveLength(1);
  expect(view.getAllByLabelText("凭据名")).toHaveLength(1);
});

test("an incomplete remote is not sent, and the panel says which half is missing", () => {
  const { view, writes } = row();
  goRemote(view);

  // Nothing posted: the whole-config rule refuses this, and the refusal would
  // come back as a Zod `error` from contracts — English, in a Chinese pane.
  expect(writes.mode).toBeUndefined();
  expect(view.getAllByText("两个都填好，远程检索就会打开。在那之前它保持本地。")).toHaveLength(1);

  // Named one at a time as they are filled, because the panel can see which box
  // is still empty — it is drawing it.
  cleanup();
  const filled = row({ endpoint: REMOTE.endpoint });
  goRemote(filled.view);
  expect(filled.writes.mode).toBeUndefined();
  expect(filled.view.getAllByText("填一个已存的凭据名，远程检索就会打开。")).toHaveLength(1);
});

test("a complete remote is sent, and says nothing", () => {
  const { view, writes } = row({ ...REMOTE });
  goRemote(view);
  expect(writes.mode).toBe("remote");
  expect(view.queryAllByText(/远程检索就会打开/)).toHaveLength(0);
});

test("switching back to local writes the mode and leaves the model to the next keystroke", () => {
  const { view, writes } = row({ mode: "remote", model: "text-embedding-3-large", ...REMOTE });
  fireEvent.click(view.getAllByRole("radio", { name: "本地" })[0]!);
  expect(writes.mode).toBe("local");
  // Not cleared for the boss: a mode switch that wiped the box would lose a model
  // name somebody had just pasted in to compare against.
  expect(writes["embedding.model"]).toBeUndefined();
});
