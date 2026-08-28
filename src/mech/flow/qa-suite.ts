import { msg, plural } from "@lingui/core/macro";
import { z } from "zod";
import type { Ctx } from "../ctx.ts";
import type { Config } from "../../platform/config/load.ts";
import { jsonOr, type Json } from "../../contracts/json.ts";
import { type LeaseArgs, loadResource, runResource } from "../lease.ts";
import { execIn, putFile, resourceExec, type Scope, WORK } from "../sandbox/sandbox.ts";
import { shq } from "../../platform/process/shell.ts";
import { recordGate } from "../gate.ts";

/**
 * A browser run that passed is a QA procedure, and it used to be thrown away.
 *
 * QA writes its steps into the worktree, leases the browser, and the file is gone
 * by the next slice — so the same behaviour is re-derived by the next reviewer,
 * and nothing checks that slice three did not break what slice one accepted.
 */
/** Into the repository, not a note: it belongs in the pull request the boss
 *  reads, it diffs, and it travels with the branch. Named by content, so the same
 *  scenario recorded twice is one file and an edited one is a new scenario. */
const QA_DIR = ".orch/qa";

export async function keepQaSteps(
  ctx: Ctx,
  scope: Scope,
  cwd: string,
  resource: string,
  args: LeaseArgs,
): Promise<void> {
  const steps = args.steps;
  if (resource !== "browser" || typeof steps !== "string") return;
  const read = await execIn(ctx, scope, `cat ${shq(steps)}`, { cwd });
  if (read.code !== 0 || !read.out.trim()) return;
  const name = `${Bun.hash(read.out.trim()).toString(16)}.json`;
  await execIn(ctx, scope, `mkdir -p ${QA_DIR} && cp ${shq(steps)} ${shq(`${QA_DIR}/${name}`)}`, { cwd });
}

/**
 * Every QA procedure this project has accepted, run again.
 *
 * The suite accumulates: slice one's scenario is still checked when slice seven
 * lands, which is the thing nothing did before — a reviewer verified the
 * behaviour in front of it and nobody re-verified the behaviour behind it.
 */
/** One lease for all of them, not one each: the steps are arrays, so they
 *  concatenate, and each set seeds the state it needs through its `api` steps. A
 *  project with no `scripts/browse.ts` has no browser resource and no suite. */
export async function replayQa(ctx: Ctx, cfg: Config, grpId: number, sliceId: number, seq: number): Promise<void> {
  const def = await loadResource(ctx.db, "browser");
  if (!def) return;
  const scope: Scope = { grp: grpId };
  const listed = await execIn(ctx, scope, `ls -1 ${QA_DIR}/*.json 2>/dev/null || true`, { cwd: WORK });
  const files = listed.out
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f && !f.endsWith("replay.json"));
  if (!files.length) return;

  const steps: Json[] = [];
  for (const file of files) {
    const read = await execIn(ctx, scope, `cat ${shq(file)}`, { cwd: WORK });
    const parsed = jsonOr(read.out, z.array(z.json()), null);
    if (parsed) steps.push(...parsed);
  }
  if (!steps.length) return;

  // Written by the orchestrator into the worktree, never by an agent: a step file
  // is data the runner executes, and who wrote it is the whole reason that is safe.
  const merged = `${QA_DIR}/replay.json`;
  await putFile(ctx, scope, `${WORK}/${merged}`, JSON.stringify(steps));
  const out = await runResource(
    def,
    { steps: merged },
    { exec: resourceExec(ctx, scope), cwd: WORK, timeoutMs: cfg.leaseTimeoutMs },
  );
  const pass = "digest" in out && out.exitCode === 0;
  await recordGate(ctx.db, sliceId, "regression", pass ? "pass" : "fail");
  await ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "gate_result",
    say: pass
      ? msg`S${{ seq }}: ${plural({ n: files.length }, { one: "# accepted QA procedure", other: "# accepted QA procedures" })} still pass`
      : msg`S${{ seq }} breaks a QA procedure an earlier slice was accepted on`,
    meta: { slice_id: sliceId, procedures: files.length },
  });
}
