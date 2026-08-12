/**
 * Claim versus diff.
 *
 * "The journal says it is done but nothing changed" is the characteristic
 * failure of agent systems, and an LLM reviewer will happily rubber-stamp it.
 * This check is deterministic on purpose: it compares what was claimed against
 * what git actually shows, and it runs before any reviewer sees the work.
 */

export interface ReconcileInput {
  /** What the agent said it produced (`orch task done --claim …`). */
  claims: unknown[];
  /** Paths git reports as changed since the slice started. */
  changedFiles: string[];
}

export interface ReconcileResult {
  pass: boolean;
  /** Files the agent claimed that git does not show as changed. */
  phantom: string[];
  /** Files git shows that nothing claimed. Reported, never fatal. */
  unclaimed: string[];
  reason?: string;
}

/** Anything that looks like a repo path inside a free-form claim. */
const PATHISH = /(?:^|[\s"'`(,])((?:[\w.@-]+\/)+[\w.@-]+\.[\w]{1,8})/g;

export function extractClaimedFiles(claims: unknown[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === "string") {
      // A claim may be prose or structured; both mention paths the same way.
      for (const m of v.matchAll(PATHISH)) out.add(m[1]!);
      if (/^[\w.@/-]+\.[\w]{1,8}$/.test(v.trim())) out.add(v.trim());
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  for (const c of claims) walk(c);
  return [...out];
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const changed = new Set(input.changedFiles.map(normalise));
  const claimed = extractClaimedFiles(input.claims).map(normalise);

  // Claimed work with an empty diff is the case worth catching loudly.
  if (claimed.length > 0 && changed.size === 0) {
    return {
      pass: false,
      phantom: claimed,
      unclaimed: [],
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
      reason: `claimed but not changed: ${phantom.join(", ")}`,
    };
  }
  if (claimed.length === 0 && changed.size === 0) {
    return { pass: false, phantom: [], unclaimed: [], reason: "nothing was claimed and nothing changed" };
  }
  // Extra changed files are normal (a test file, a lockfile) and are surfaced
  // for the reviewer rather than treated as a failure.
  return { pass: true, phantom: [], unclaimed };
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
