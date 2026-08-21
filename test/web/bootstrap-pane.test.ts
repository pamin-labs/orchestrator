import { expect, test } from "bun:test";
import { bootstrapOf } from "../../web/src/features/requirement/bootstrap.ts";
import type { PanelFrame } from "../../web/src/shared/stream.ts";

/**
 * The pane that watches a sandbox being rebuilt. What can be wrong here is the
 * bookkeeping, not the markup: which run is the current one, whether the clone
 * finished, and whether the thing ended badly — which is the one outcome that
 * has to stay on the page rather than vanish with the pane.
 */
let seq = 0;
const f = (o: Partial<PanelFrame> & { text: string; cls: PanelFrame["cls"] }): PanelFrame => ({
  id: `f${++seq}`,
  grpId: 1,
  projectId: 1,
  at: seq * 1000,
  author: "orchestrator",
  agentId: null,
  ...o,
});

const started = () => f({ cls: "state", text: "沙箱是新的，把 orch/g1 和依赖装回去" });
const cmd = () => f({ cls: "tool", text: "$ bun install --frozen-lockfile" });
const out = (t: string) => f({ cls: "tool", text: t });

test("a run in flight is shown, with the command it is on", () => {
  const b = bootstrapOf([started(), cmd(), out("Resolving dependencies")], 1);
  expect({ running: b.running, failed: b.failed }).toEqual({ running: true, failed: false });
  expect(b.cmd).toBe("bun install --frozen-lockfile");
  expect(b.lines).toHaveLength(2);
});

test("the clone is still going until the install prints its command", () => {
  const b = bootstrapOf([started()], 1);
  expect(b.running).toBe(true);
  expect(b.cmd).toBeNull();
});

test("a finished run leaves nothing on the page", () => {
  // The record keeps the outcome. A pane that also kept it would be the same
  // fact twice, 200px apart.
  const b = bootstrapOf([started(), cmd(), f({ cls: "state", text: "装好了：bun install" })], 1);
  expect({ running: b.running, failed: b.failed }).toEqual({ running: false, failed: false });
});

test("a failed run stays, because it is the one outcome to act on", () => {
  const b = bootstrapOf([started(), cmd(), f({ cls: "state", text: "装失败了（exit 1）：bun install" })], 1);
  expect({ running: b.running, failed: b.failed }).toEqual({ running: false, failed: true });
});

test("a second rebuild is its own run, not the first one continued", () => {
  // Concatenating them made the header quote the command from the run before.
  const first = [started(), cmd(), f({ cls: "state", text: "装好了：bun install" })];
  const again = f({ cls: "state", text: "沙箱是新的，把 orch/g1 和依赖装回去" });
  const b = bootstrapOf([...first, again, f({ cls: "tool", text: "$ pnpm i" })], 1);
  expect(b.cmd).toBe("pnpm i");
  expect(b.lines).toHaveLength(1);
  expect(b.running).toBe(true);
});

test("another group's rebuild is not this one's", () => {
  const other = { ...started(), grpId: 2 };
  expect(bootstrapOf([other], 1).running).toBe(false);
});

test("an agent's own output is not the installer's", () => {
  // Turn output is `tool` too, and it carries an agentId; the installer runs as
  // the orchestrator and has none.
  const b = bootstrapOf([started(), { ...out("reading files"), agentId: 7 }], 1);
  expect(b.lines).toHaveLength(0);
});
