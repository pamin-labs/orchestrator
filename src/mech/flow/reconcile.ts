import { z } from "zod";
import { ChangedFilesClaimSchema } from "../../contracts/orch.ts";

/** Claim versus diff. */

export { ChangedFilesClaimSchema } from "../../contracts/orch.ts";

export const AlreadyDoneClaimSchema = z.object({
  already_done: z.string().trim().min(1).max(4000),
});

/** Exactly one account of completion: changed files, or work already present. */
export const TaskClaimSchema = z.xor([ChangedFilesClaimSchema, AlreadyDoneClaimSchema]);
export type TaskClaim = z.infer<typeof TaskClaimSchema>;

export interface ReconcileInput {
  /** What the agent said it produced (`orch task done --claim …`). */
  claims: TaskClaim[];
  /** Paths git reports as changed since the slice started. */
  changedFiles: string[];
  /**
   * Claimed paths that are neither in the branch point's tree nor in the worktree.
   *
   * A scratch file the Engineer created and then deleted leaves nothing behind:
   * never committed, so it is not in the diff, and gone, so it is not untracked
   * either. Reporting that deletion honestly was scored as a phantom claim, and a
   * correct branch went back twice on it. Git cannot tell that case from an
   * invented path — neither ever existed as far as it is concerned — so neither
   * can we, and neither is a delivery. They are dropped from the claim rather than
   * failing it; if nothing real is left, the checks below still catch it.
   */
  absent?: string[];
}

/**
 * Did the agent declare this slice already satisfied by earlier work?
 *
 * A real case, seen on the first multi-slice live run: the Engineer implemented
 * the whole feature while working slice 1, so slices 2 and 3 had nothing left to
 * change. Treating that as fraud sent a correct branch back three times and then
 * escalated. The claim of "already done" is legitimate — but only if the gate and
 * the acceptance spec still pass, which they are checked for separately.
 */
function declaredNoOp(claims: TaskClaim[]): string | null {
  return (
    claims.find((claim): claim is z.infer<typeof AlreadyDoneClaimSchema> => "already_done" in claim)?.already_done ??
    null
  );
}

export interface ReconcileResult {
  pass: boolean;
  /** Files the agent claimed that git does not show as changed. */
  phantom: string[];
  /** Files git shows that nothing claimed. Reported, never fatal. */
  unclaimed: string[];
  /** Claimed paths that never existed either side. Reported, never fatal. */
  ignored: string[];
  reason?: string;
}

/** Anything that looks like a repo path inside a DRAFT card. */
const PATHISH = /(?:^|[\s"'`(,])((?:[\w.@-]+\/)+[\w.@-]+\.[\w]{1,8})/g;

export function extractClaimedFiles(claims: readonly (TaskClaim | string)[]): string[] {
  const out = new Set<string>();
  for (const claim of claims) {
    if (typeof claim === "string") {
      for (const match of claim.matchAll(PATHISH)) out.add(match[1]!);
      continue;
    }
    if ("files" in claim) for (const file of claim.files) out.add(file);
  }
  return [...out];
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const changed = new Set(input.changedFiles.map(normalise));
  const absent = new Set((input.absent ?? []).map(normalise));
  const all = extractClaimedFiles(input.claims).map(normalise);
  const ignored = all.filter((c) => absent.has(c));
  const claimed = all.filter((c) => !absent.has(c));

  const noOp = declaredNoOp(input.claims);
  if (noOp && changed.size === 0) {
    // Nothing changed and nobody claimed otherwise. Whether the slice is really
    // satisfied is the gate's and QA's question, not this one's.
    return { pass: true, phantom: [], unclaimed: [], ignored, reason: `declared already done: ${noOp}` };
  }

  // Claimed work with an empty diff is the case worth catching loudly.
  if (claimed.length > 0 && changed.size === 0) {
    return {
      pass: false,
      phantom: claimed,
      unclaimed: [],
      ignored,
      reason: `claimed ${claimed.length} file(s) but git shows no changes at all`,
    };
  }

  const phantom = claimed.filter((c) => !hasSuffixMatch(changed, c));
  const unclaimed = [...changed].filter((f) => !claimed.some((c) => sameFile(c, f)));

  if (phantom.length > 0) {
    return {
      pass: false,
      phantom,
      unclaimed,
      ignored,
      reason: `claimed but not changed: ${phantom.join(", ")}`,
    };
  }
  if (claimed.length === 0 && changed.size === 0) {
    return { pass: false, phantom: [], unclaimed: [], ignored, reason: "nothing was claimed and nothing changed" };
  }
  // Extra changed files are normal (a test file, a lockfile) and are surfaced
  // for the reviewer rather than treated as a failure.
  return { pass: true, phantom: [], unclaimed, ignored };
}

function normalise(p: string): string {
  return p.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** A claim may name a file by a suffix of its repo path; git gives the full one. */
function hasSuffixMatch(changed: Set<string>, claim: string): boolean {
  for (const f of changed) if (sameFile(claim, f)) return true;
  return false;
}

function sameFile(claim: string, changed: string): boolean {
  return changed === claim || changed.endsWith(`/${claim}`) || claim.endsWith(`/${changed}`);
}
