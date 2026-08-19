import type { GhResult, Github } from "./github.ts";
import type { z } from "zod";

/**
 * The pager, in the one file both `github.ts` and `ghlogin.ts` can import.
 *
 * It reads as though it belongs in `github.ts`, and it lived there first — but
 * `github.ts` imports `loadAuth`, which reaches `ghlogin.ts`, so a *value*
 * import from `ghlogin.ts` closed a cycle that its type-only imports never did.
 * Same shape as `ui/accordion.tsx`: the shared thing moves to a module neither
 * side owns.
 */
/** GitHub's maximum, and what every list call here asks for. */
export const PER_PAGE = 100;
/** A ceiling, so a runaway cursor cannot spend the whole rate limit. */
const MAX_PAGES = 10;
/**
 * Every page of a list endpoint, or the first failure.
 *
 * A single `per_page=100` request reads as complete and is not: `/reviews` has no
 * `since` and returns oldest-first, so past a hundred reviews the newest were never
 * seen and the PM stopped being woken. `/check-runs` is worse — what it truncates is
 * the failures a gate exists to report.
 *
 * `gh.request`, not `octokit.paginate`: the plugin drives the raw client.
 */
export async function pages<T, R>(
  gh: Github,
  path: string,
  schema: z.ZodType<R>,
  pick: (page: R) => T[],
  opts: { signal?: AbortSignal | undefined; limit?: number } = {},
): Promise<GhResult<T[]>> {
  const out: T[] = [];
  const limit = opts.limit ?? MAX_PAGES;
  for (let page = 1; page <= limit; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const answer = await gh.request(
      "GET",
      `${path}${sep}per_page=${PER_PAGE}&page=${page}`,
      schema,
      undefined,
      opts.signal,
    );
    if (!answer.ok) return answer;
    const items = pick(answer.data);
    out.push(...items);
    if (items.length < PER_PAGE) break;
  }
  return { ok: true, status: 200, data: out };
}
