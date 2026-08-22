import { JsonValue } from "../../src/contracts/json.ts";
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
  const ctx = await testContext({ sandbox: fakeSandbox() });
  const f = fx.on(ctx.db);
  const p = await f.project.create({ name: "p" });
  const g = await f.grp.create({ project_id: p.id, name: "g" });
  await f.agent.create({ project_id: p.id, grp_id: g.id, token: "t" });
  const slice = await f.slice.create({ grp_id: g.id, seq: 1, title: "add the menu" });
  const job: Job<"agent_turn"> = {
    id: 1,
    kind: "agent_turn",
    grp_id: g.id,
    agent_id: null,
    slice_id: opts.sliceId ? slice.id : null,
    // Through the contract, as the scheduler does: an optional field is
    // `undefined` in TypeScript and absent in JSON, and the column takes JSON.
    payload_json: JsonValue.parse(payload),
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

/**
 * A card that loses takes its quoted span with it.
 *
 * Every builder in `applyPayloadCards` runs and the last one that fired wins, so
 * a builder can lose — and nothing in `AgentTurnPayloadSchema` stops a payload
 * carrying an escalation *and* a digest, because every field is independently
 * optional. When a span was pushed as it was built rather than carried by its
 * card, the loser's survived: a fenced `<<DATA:question:…>>` block in a turn
 * whose prose is about compressing a backlog, with nothing to say what it was.
 */
test("a losing card does not leave its quoted span behind", async () => {
  const ctx = await testContext({ sandbox: fakeSandbox() });
  const f = fx.on(ctx.db);
  const p = await f.project.create({ name: "p" });
  const g = await f.grp.create({ project_id: p.id, name: "g" });
  const a = await f.agent.create({ project_id: p.id, grp_id: g.id, token: "t" });
  const channel = await f.channel.create({ grp_id: g.id });
  const esc = await f.escalation.create({ grp_id: g.id, agent_id: a.id, question: "which base branch?" });

  const job: Job<"agent_turn"> = {
    id: 1,
    kind: "agent_turn",
    grp_id: g.id,
    agent_id: null,
    slice_id: null,
    payload_json: JsonValue.parse({ escalation: esc.id, digest: { channel_id: channel.id, from: 0, to: 99 } }),
    priority: 5,
    state: "running",
    payload: { escalation: esc.id, digest: { channel_id: channel.id, from: 0, to: 99 } },
  };
  const d = await buildTurnDelta({ ctx, cfg: loadConfig() }, agent, job, false, { grp: g.id });

  // The digest is later in the list, so it wins the card.
  expect(d.card).toContain("Compress the channel backlog");
  // And it is the only thing quoted: the escalation's question went with the
  // card that lost.
  expect((d.quoted ?? []).map((q) => q.label)).toEqual(["backlog"]);
});

/**
 * The turn that cuts a boundary is told how to cut it.
 *
 * `applyPayloadCards` keeps the last builder that fired, and `idea` sits after
 * `boundary` in that list — so `payload: { boundary, idea }`, which is what
 * `api/panel/group.ts` enqueued, threw the boundary card away and left the turn
 * reading "The boss wants: …" with no `orch owns` command anywhere in it. A
 * live instance of the same loop the quoted-span fix above is about.
 */
test("a boundary turn keeps the command it exists to issue", async () => {
  const d = await delta({
    boundary: [{ id: 1, name: "g", idea: "add a cache" }],
  });
  expect(d.card).toContain("orch owns 1 --path");
  // And the shape that was being enqueued, so the reason this test exists stays
  // legible: `idea` after `boundary` wins the card and the command is gone.
  const both = await delta({
    boundary: [{ id: 1, name: "g", idea: "add a cache" }],
    idea: "add a cache",
  });
  expect(both.card).not.toContain("orch owns");
});
