import { expect, test } from "bun:test";
import { buildTurnDelta } from "../../src/application/turn/delta.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { testContext } from "../support/test-context.ts";
import * as fx from "../support/factories.ts";
import type { Job } from "../../src/platform/scheduling/scheduler.ts";

/**
 * What a turn is told it is there to do.
 *
 * `applyPayloadCards` writes the reason the turn was enqueued; `applyWorkCard`
 * runs after it. Anything that reached the second one unguarded lost the first,
 * and every affected payload — a lease result, a digest, a scribe brief — has no
 * other delivery path into the prompt.
 */

const agent = { id: 1, project_id: 1, role: "engineer" };

type TurnPayload = Job<"agent_turn">["payload"];

async function delta(payload: TurnPayload, opts: { sliceId?: boolean } = {}) {
  const ctx = testContext({ sandbox: fakeSandbox() });
  const p = fx.project.insert(ctx.db, { name: "p" });
  const g = fx.grp.insert(ctx.db, { project_id: p.id, name: "g" });
  fx.agent.insert(ctx.db, { project_id: p.id, grp_id: g.id, token: "t" });
  const slice = fx.slice.insert(ctx.db, { grp_id: g.id, seq: 1, title: "add the menu" });
  const job: Job<"agent_turn"> = {
    id: 1,
    kind: "agent_turn",
    grp_id: g.id,
    agent_id: null,
    slice_id: opts.sliceId ? slice.id : null,
    payload_json: JSON.stringify(payload),
    priority: 5,
    state: "running",
    payload,
  };
  return await buildTurnDelta({ ctx, cfg: loadConfig() }, agent, job, false, { grp: g.id });
}

test("a lease result reaches the turn it woke, on a group that has slices", async () => {
  // `finishLease` enqueues exactly this: grp_id set, no slice_id, the digest on
  // `payload.mail`. `lease_result` is not a kind `readUnread` collects, so if the
  // card is overwritten the agent is never told the lease finished — and re-runs it.
  const d = await delta({
    mail: { from: "runner", from_group: 1, intent: "inform", body: "lease #7 finished:\nall green" },
  });
  expect(d.card).toContain("lease #7 finished");
});

test("a slice turn still gets its acceptance criteria", async () => {
  // The guard must not cost the slice card, which is the other thing that path
  // produces and the only place `Accepted when` comes from.
  const d = await delta({}, { sliceId: true });
  expect(d.card).toContain("Accepted when:");
});

test("a turn with no payload card falls back to the slice list", async () => {
  const d = await delta({});
  expect(d.card).toContain("add the menu");
});
