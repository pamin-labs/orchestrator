import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { z } from "zod";
import * as fx from "../support/factories.ts";
import { tempDir } from "../support/temp.ts";

/**
 * The two panels the boss reads before pressing a button.
 *
 * `evidence` is what makes accepting a slice a judgement rather than a rubber
 * stamp, and `draft` is the answer the boss is offered for a question. Both are
 * assembled from four sources each, and neither was reachable from a test — so
 * an empty panel and a correct one were the same observation.
 */

const Evidence = z.object({
  seq: z.number(),
  title: z.string(),
  stat: z.string(),
  diff: z.string(),
  truncated: z.boolean(),
  scope: z.enum(["slice", "branch"]),
  verdicts: z.array(z.object({ author: z.string(), body: z.string(), at: z.number() })),
  gates: z.array(z.object({ name: z.string(), path: z.string(), size: z.number() })),
});
const Draft = z.object({ text: z.string() });

function harness(opts: { handle?: (cmd: string) => { code?: number; out?: string }; language?: string } = {}) {
  const dataDir = tempDir("orch-ev-");
  const db = openMemory();
  seedAuth(db);
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    sandbox: fakeSandbox((cmd) => opts.handle?.(cmd) ?? {}),
    waiters: new Map(),
    config: { ...loadConfig(), dataDir, ...(opts.language ? { language: opts.language } : {}) },
  };
  const p = fx.project.insert(db, {
    name: "p",
    repo_path: "o/p",
    config_json: JSON.stringify({ gates: ["typecheck", "test"] }),
    base_branch: "main",
  });
  fx.runningGrp.insert(db, { project_id: p.id, name: "ship-the-thing" });
  const app = makeApp(ctx);
  const get = (path: string) => app(new Request(`http://x${path}`));
  return { db, ctx, app, get, dataDir };
}

const slice = (db: ReturnType<typeof harness>["db"], baseSha: string | null) =>
  fx.slice.insert(db, {
    grp_id: 1,
    seq: 3,
    title: "S3 rename the flag",
    accept_spec: "the flag is gone",
    difficulty: "trivial",
    status: "qa",
    base_sha: baseSha,
  });

/** A checkout whose base is `base_sha` and whose diff is one hunk. */
const normalGit = (diff: string) => (cmd: string) => {
  if (cmd.includes("is-ancestor")) return { code: 0 };
  if (cmd.includes("merge-base")) return { code: 0, out: "f0f0f0\n" };
  if (cmd.includes("'diff' '--stat'")) return { code: 0, out: " a.ts | 2 +-\n" };
  if (cmd.includes("'diff'")) return { code: 0, out: diff };
  return { code: 1 };
};

// ------------------------------------------------------- slices/:id/evidence

test("evidence for a slice that is not there is a 404, not an empty panel", async () => {
  const h = harness();
  const r = await h.get("/api/v1/slices/99/evidence");
  expect(r.status).toBe(404);
});

test("evidence carries the diff, both verdicts in order, and the gate logs on disk", async () => {
  const h = harness({ handle: normalGit("@@ -1 +1 @@\n-old\n+new\n") });
  slice(h.db, "abc123");
  // Both reviewers file through the same route: QA on the slice, the Auditor on
  // the branch. The panel shows them in the order they were given.
  for (const [author, body] of [
    ["qa", "S3 pass: the flag is gone"],
    ["auditor", "audit pass"],
  ] as const) {
    h.ctx.bus.emit({ grpId: 1, author, kind: "gate_result", intent: "decision", body, meta: { slice_id: 1 } });
  }
  mkdirSync(join(h.dataDir, "gates"), { recursive: true });
  writeFileSync(join(h.dataDir, "gates", "1-typecheck.log"), "no errors\n");
  // `test` is a configured gate with no log: a gate that never ran must not be
  // offered as a link to nothing.

  const r = await h.get("/api/v1/slices/1/evidence");
  expect(r.status).toBe(200);
  const e = Evidence.parse(await r.json());
  expect(e.seq).toBe(3);
  expect(e.title).toBe("S3 rename the flag");
  expect(e.stat).toBe("a.ts | 2 +-");
  expect(e.diff).toContain("+new");
  expect(e.truncated).toBe(false);
  expect(e.scope).toBe("slice");
  expect(e.verdicts.map((v) => v.author)).toEqual(["qa", "auditor"]);
  expect(e.gates).toHaveLength(1);
  expect(e.gates[0]!.name).toBe("typecheck");
  expect(e.gates[0]!.size).toBe(10);
});

test("a diff past the cap is cut and says it was cut", async () => {
  const huge = "+x\n".repeat(200_000);
  const h = harness({ handle: normalGit(huge) });
  slice(h.db, "abc123");

  const e = Evidence.parse(await (await h.get("/api/v1/slices/1/evidence")).json());
  // Silently short is the failure mode this flag exists to prevent: the boss has
  // to know they are not looking at all of it.
  expect(e.truncated).toBe(true);
  expect(e.diff.length).toBe(400_000);
});

test("a slice with no diff base renders as an empty diff rather than failing", async () => {
  // No base_sha and a checkout git cannot answer for: `sliceDiffBase` returns
  // nothing, and the panel still has a title, a verdict list and its gates.
  const h = harness({ handle: () => ({ code: 128, out: "fatal: not a git repository" }) });
  slice(h.db, null);

  const e = Evidence.parse(await (await h.get("/api/v1/slices/1/evidence")).json());
  expect(e.stat).toBe("");
  expect(e.diff).toBe("");
  expect(e.truncated).toBe(false);
  expect(e.scope).toBe("slice");
  expect(e.verdicts).toEqual([]);
});

test("a slice whose base was rebased away is diffed against the fork, not the stale commit", async () => {
  const h = harness({
    handle: (cmd) => {
      // The stored base is no longer an ancestor of HEAD — what a rebase leaves
      // behind. Diffing against it would pick up every other group's landed work.
      if (cmd.includes("is-ancestor")) return { code: 1 };
      if (cmd.includes("merge-base")) return { code: 0, out: "f0f0f0\n" };
      if (cmd.includes("'diff' '--stat'")) return { code: 0, out: " a.ts | 1 +\n" };
      if (cmd.includes("'diff'")) return { code: 0, out: "+one\n" };
      return { code: 1 };
    },
  });
  slice(h.db, "stale99");

  const e = Evidence.parse(await (await h.get("/api/v1/slices/1/evidence")).json());
  expect(e.scope).toBe("branch");
  expect(e.diff).toBe("+one");
});

// ---------------------------------------------------- escalations/:id/draft

function question(h: ReturnType<typeof harness>, opts: { grp: boolean; answered?: boolean }) {
  fx.agent.insert(h.db, { project_id: 1, grp_id: opts.grp ? 1 : null });
  fx.escalation.insert(h.db, {
    grp_id: opts.grp ? 1 : null,
    agent_id: 1,
    severity: "blocker",
    question: "which validation library should S3 use?",
    chain_state: "boss",
    answer: opts.answered ? "already said" : null,
  });
}

test("no cheap model configured means no draft, and no error either", async () => {
  const h = harness();
  question(h, { grp: true });
  const r = await h.get("/api/v1/escalations/1/draft");
  expect(r.status).toBe(200);
  expect(Draft.parse(await r.json()).text).toBe("");
});

test("a question that is already answered is never redrafted", async () => {
  const h = harness();
  question(h, { grp: true, answered: true });
  let called = false;
  h.ctx.askIn = () => async () => {
    called = true;
    return "here is an answer";
  };
  expect(Draft.parse(await (await h.get("/api/v1/escalations/1/draft")).json()).text).toBe("");
  expect(called).toBe(false);
  // Nor is a question that does not exist.
  expect(Draft.parse(await (await h.get("/api/v1/escalations/9/draft")).json()).text).toBe("");
});

test("the draft prompt carries the requirement, the asker, the slices and the blackboard", async () => {
  const h = harness();
  question(h, { grp: true });
  fx.slice.insert(h.db, {
    grp_id: 1,
    seq: 3,
    title: "rename the flag",
    difficulty: "trivial",
    status: "qa",
  });
  fx.note.insert(h.db, { project_id: 1, grp_id: 1, kind: "decision", body: "we settled on zod" });
  fx.note.insert(h.db, { project_id: 1, kind: "lesson", body: "a project-wide lesson" });
  let prompt = "";
  h.ctx.askIn = () => async (p) => {
    prompt = p;
    return "  use zod  ";
  };

  expect(Draft.parse(await (await h.get("/api/v1/escalations/1/draft")).json()).text).toBe("use zod");
  expect(prompt).toContain("需求: ship-the-thing");
  expect(prompt).toContain("提问的人: engineer (blocker)");
  expect(prompt).toContain("which validation library should S3 use?");
  expect(prompt).toContain("S3 qa rename the flag");
  expect(prompt).toContain("[decision] we settled on zod");
  // A project-level decision is context for a group question too — that is what
  // makes the blackboard shared rather than per-group.
  expect(prompt).toContain("[lesson] a project-wide lesson");
});

test("a standing agent's question drafts against no requirement and no slices", async () => {
  const h = harness({ language: "en" });
  question(h, { grp: false });
  let prompt = "";
  h.ctx.askIn = () => async (p) => {
    prompt = p;
    return "the answer";
  };

  expect(Draft.parse(await (await h.get("/api/v1/escalations/1/draft")).json()).text).toBe("the answer");
  expect(prompt).toContain("You draft answers for the boss");
  expect(prompt).toContain("requirement: standing");
  expect(prompt).toContain("asker: engineer (blocker)");
  // Nothing to show is shown as nothing, not as an empty heading.
  expect(prompt).not.toContain("slices:");
  expect(prompt).not.toContain("blackboard:");
});

test("a draft is capped, and a model that fails leaves the composer alone", async () => {
  const h = harness();
  question(h, { grp: true });
  h.ctx.askIn = () => async () => "x".repeat(5000);
  expect(Draft.parse(await (await h.get("/api/v1/escalations/1/draft")).json()).text).toHaveLength(1200);

  const broken = harness();
  question(broken, { grp: true });
  broken.ctx.askIn = () => async () => {
    throw new Error("the cheap model is unreachable");
  };
  const r = await broken.get("/api/v1/escalations/1/draft");
  expect(r.status).toBe(200);
  expect(Draft.parse(await r.json()).text).toBe("");
});
