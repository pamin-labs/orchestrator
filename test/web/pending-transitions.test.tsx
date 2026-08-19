import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { cleanup, isDisabled, render as mount, restoreFetch } from "../support/render.tsx";
import { WithQueries } from "./queries.tsx";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { ServerPane, type ServerInfo } from "../../web/src/features/settings/environment.tsx";

/**
 * That `isPending` really does span the `await`.
 *
 * Eleven buttons stopped keeping their own `busy` boolean on the strength of one
 * claim about React 19: that a `startTransition` handed an async function stays
 * pending until that function returns, rather than until it is first suspended. If
 * the claim is wrong, all eleven un-disable the instant the request leaves — and on
 * one of them that means a second sandbox server.
 */
/**
 * So it is measured here rather than reasoned about, against the real component and
 * a request the test holds open. `docs/standards/testing.md` asks for exactly this
 * for exactly this class of claim: something a library does at runtime.
 */
const server = (over: Partial<ServerInfo> = {}): ServerInfo => ({
  running: false,
  addr: "127.0.0.1:9999",
  inClear: false,
  state: "down",
  why: null,
  pid: null,
  config: null,
  argv: [],
  restartable: false,
  drift: null,
  log: "",
  containers: 0,
  runningTurns: 0,
  ...over,
});

/** A POST the test decides when to answer. */
function heldFetch() {
  let release!: () => void;
  const answered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = async (): Promise<Response> => {
    await answered;
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  };
  globalThis.fetch = Object.assign(answer, { preconnect: fetch.preconnect });
  return {
    release: async () => {
      release();
      await act(async () => {
        await answered;
      });
    },
  };
}

afterEach(() => {
  cleanup();
  restoreFetch();
});

test("a button stays pending for the whole write, not just until the request leaves", async () => {
  const net = heldFetch();
  const { getByRole } = mount(
    <WithQueries>
      <TipRoot>
        <ServerPane
          checks={[]}
          server={server()}
          image=""
          onRefreshServer={() => {}}
          onRefreshImages={() => {}}
          onSaved={() => {}}
        />
      </TipRoot>
    </WithQueries>,
  );

  const button = getByRole("button", { name: "起一个" });
  expect(isDisabled(button)).toBe(false);

  await act(async () => {
    button.click();
  });

  // The request is out and unanswered. The control says so and refuses to start
  // a second server — this is the assertion the whole conversion rests on.
  const busy = getByRole("button", { name: "起中…" });
  expect(isDisabled(busy)).toBe(true);

  await net.release();
  expect(isDisabled(getByRole("button", { name: "起一个" }))).toBe(false);
});
