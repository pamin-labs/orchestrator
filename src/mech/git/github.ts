import type { DB } from "../../db.ts";
import { say } from "../../lang.ts";
import { loadAuth } from "../sandbox/auth.ts";

/**
 * GitHub, as eight endpoints of ordinary JSON.
 *
 * Not `@octokit/rest`: what we ask GitHub is PR create / edit / view, checks,
 * comments, reviews, `/user` and one repo read. A whole SDK for that is a
 * dependency to answer a `fetch`. Not `gh` either — the point of 007 is that a
 * host with docker, the image and a pasted token can run, and every shelled-out
 * binary is one more thing that has to be installed and separately logged in.
 *
 * The credential is the one in `runtime_auth`, never a host CLI's login. That
 * distinction is what `test/one-model-path.test.ts` guards: two accounts behind
 * one label is how the fleet spent a night 401ing on a token the panel could not
 * see.
 */

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;

/**
 * Who can do something about it. Three buckets because they need three
 * different answers (007 §6): the boss fixes a credential, an agent fixes a
 * conflict, and nobody fixes a 502 — it is waited out.
 */
export type Bucket = "boss" | "agent" | "transient";

export interface GhFail {
  ok: false;
  bucket: Bucket;
  /** 0 for a transport-level throw, which has no status. */
  status: number;
  message: string;
}
export interface GhOk<T> {
  ok: true;
  status: number;
  data: T;
}
export type GhResult<T> = GhOk<T> | GhFail;

/** Only the shape this uses, so a test stub is a `new Response(...)`. */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export interface Github {
  request<T>(method: string, path: string, body?: unknown): Promise<GhResult<T>>;
  /** `x-ratelimit-remaining` from the last answer; null before the first one. */
  remaining(): number | null;
}

/**
 * 404 is not "deleted".
 *
 * GitHub answers **404, not 403**, for a private repository a token cannot see —
 * deliberately, so existence does not leak. So "repo deleted", "org revoked
 * third-party access", "user removed from the org" and "token lost its scope"
 * arrive as the same response, and nothing here can tell them apart. Saying
 * "deleted" when it was an org policy change sends the boss to the wrong page,
 * so this says what is true — the login cannot reach it — and lists what to
 * check.
 */
function unreachable(what: string): string {
  return (
    `this login can no longer reach ${what}. GitHub answers 404 for a repository a token cannot see, ` +
    `exactly as it does for one that is gone, so which of these it is cannot be told from here. Check: ` +
    `the GitHub credential in settings is still valid; the repository still exists under that name ` +
    `(a rename or transfer moves it); your account still has access to it; the organisation still allows ` +
    `this token's access.`
  );
}

/**
 * Which bucket an HTTP answer falls in.
 *
 * The agent bucket is mostly not errors at all — a merge conflict, a red check
 * and a review comment are 200s whose *body* says so, and `prwatch` reads them
 * there. What lands here is 422: GitHub understood the request and refused its
 * content ("No commits between…", "A pull request already exists"), which is a
 * fact about the branch rather than about the login.
 */
export function classify(status: number, message: string): Bucket {
  if (status === 0) return "transient"; // network throw
  if (status >= 500) return "transient";
  if (status === 429) return "transient";
  // Secondary rate limits arrive as 403 with a body saying so, and retrying
  // later is exactly the right answer — unlike every other 403.
  if (status === 403 && /rate limit|secondary|abuse detection/i.test(message)) return "transient";
  if (status === 401 || status === 403 || status === 404) return "boss";
  return "agent";
}

/** `owner/repo` out of any remote URL git will accept. Null if it is not GitHub. */
export function parseRepo(remote: string): string | null {
  const m = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The fifth admission gate (007 §6), and the thing the `boss` bucket is for.
 *
 * An expired GitHub token has the signature this codebase has been burned by
 * four times: every group fails at the same moment and each reports a different
 * error — clone failed, push rejected, PR create failed. Retrying is the one
 * thing that cannot help, so the project's turns are simply not dispatched,
 * exactly the way `providerHeld` holds for model quota. Held work costs nothing:
 * no process, no retry loop, no quota spent proving the wall is still there.
 *
 * **Per repository, not global.** One project's dead credential must not stop a
 * project whose credential is fine. In memory, like `net.ts`'s, because a hold
 * is a fact about right now — a restart re-learns it from the first failure.
 */
const holds = new Map<string, number>();

/**
 * How long before one turn is let through to find out whether it is fixed.
 *
 * Held is not a terminal state, and it must not need anyone to leave it: a
 * project held forever because nothing ever calls GitHub again is precisely the
 * failure this gate exists to prevent. So the hold lapses by clock the way
 * `providerHeld` does, one turn re-tests, and a success clears it for real. If
 * it is still broken that turn fails once and re-holds — one failed turn per ten
 * minutes per project, against a fleet that would otherwise fail every group
 * every tick.
 */
export const REPO_HOLD_MS = 10 * 60_000;

/** Is this project locked out of GitHub right now? The scheduler's question. */
export function repoHeld(db: DB, projectId: number, now = Date.now()): boolean {
  const slug = slugOf(db, projectId);
  if (!slug) return false;
  const until = holds.get(slug);
  if (until === undefined) return false;
  if (until <= now) {
    holds.delete(slug);
    return false;
  }
  return true;
}

/** Tests only: put the module back to its starting state. */
export function resetRepoHolds(): void {
  holds.clear();
}

/**
 * The credential changed, so nothing we learned from the old one still holds.
 *
 * A boss who reconnects GitHub and then watches nothing happen for ten minutes
 * has been told the fix did not work. Called from `saveAuth` for every runtime
 * and a no-op for the rest, so the caller needs no `if`. The open escalation
 * needs no separate sweep: the next successful call revokes it, and the next
 * call is one tick away once turns dispatch again.
 */
export function forgetHolds(runtime: string): void {
  if (runtime === "github") holds.clear();
}

function slugOf(db: DB, projectId: number): string | null {
  const p = db
    .query<{ remote: string | null }, [number]>("SELECT remote FROM project WHERE id = ?")
    .get(projectId);
  return p?.remote ? parseRepo(p.remote) : null;
}

/** `owner/repo` out of an API path, for the endpoints that name one. */
function slugInPath(path: string): string | null {
  return /^\/repos\/([^/?#]+\/[^/?#]+)/.exec(path)?.[1] ?? null;
}

/**
 * Hold the project, and tell the boss once.
 *
 * Once per repository, not once per group: the dedup is an open escalation
 * rather than a flag, the way `handleAuthFailure` does it, so it survives a
 * restart and so answering it is what re-arms the warning.
 */
function holdRepo(db: DB, lang: string | undefined, slug: string, why: string, now: number): void {
  holds.set(slug, now + REPO_HOLD_MS);
  const open = db
    .query<{ id: number }, [string]>(
      // `chain_state` matters as much as `answer`: `clearEscalation` revokes
      // rather than answers, so without it a project that recovered once could
      // never file a second warning.
      `SELECT id FROM escalation
       WHERE answer IS NULL AND chain_state NOT IN ('answered', 'revoked') AND question LIKE ?`,
    )
    .get(`GitHub ${slug}:%`);
  if (open) return;
  db.run(
    `INSERT INTO escalation (grp_id, severity, question, chain_state, kind, created_at)
     VALUES (NULL, 'blocker', ?, 'boss', 'env', ?)`,
    // `chain_state = 'boss'` directly rather than through `route()`: no agent can
    // answer "the login stopped working", and this escalation belongs to a
    // project rather than to a group, so there is no PM to hand it to.
    //
    // `why` goes in verbatim. It is the message built below, which deliberately
    // does not guess which of the four causes it was — and a wrapper that
    // "helpfully" summarised it as "token expired" would put the guess back.
    [`GitHub ${slug}: ${why}\n\n${say(lang, "repo.held", { repo: slug })}`, now],
  );
}

/**
 * It works again, so take the question back.
 *
 * A boss who reconnects GitHub and watches the fleet resume should not also have
 * to dismiss a 待办 item about it. Revoked rather than answered: nobody answered
 * it, and `dropGroup` already uses `revoked` for a question the world made moot.
 */
export function clearEscalation(db: DB, slug: string): void {
  db.run(
    `UPDATE escalation SET chain_state = 'revoked', answered_at = unixepoch() * 1000
     WHERE answer IS NULL AND chain_state != 'revoked' AND question LIKE ?`,
    [`GitHub ${slug}:%`],
  );
}

export function makeGithub(
  db: DB,
  // `Fetcher` is deliberately narrower than the global — see its docstring — so
  // the global is assignable in the direction that matters and only the argument
  // types need the widening. A double cast said "trust me about all of it".
  fetchFn: Fetcher = fetch as Fetcher,
  /** `output.language`, for the one sentence the boss reads. */
  lang?: string,
): Github {
  /**
   * ETags, keyed by token as well as URL.
   *
   * A 304 does **not** count against the primary rate limit, and `pollPrs` runs
   * every tick against every open PR — without this a quiet fleet spends its
   * 5000/hour re-reading answers it already has. Keyed by the token because a
   * rotated login must not reuse the previous one's cached bodies.
   */
  const cache = new Map<string, { etag: string; data: unknown }>();
  let remaining: number | null = null;

  return {
    remaining: () => remaining,

    async request<T>(method: string, path: string, body?: unknown): Promise<GhResult<T>> {
      const token = loadAuth(db, "github")?.secret;
      if (!token) {
        return { ok: false, bucket: "boss", status: 0, message: "no GitHub credential: connect GitHub in settings" };
      }
      const url = path.startsWith("http") ? path : API + path;
      const key = `${token}\0${url}`;
      const hit = method === "GET" ? cache.get(key) : undefined;

      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "orchestrator",
      };
      if (hit) headers["if-none-match"] = hit.etag;
      if (body !== undefined) headers["content-type"] = "application/json";

      let res: Response;
      try {
        res = await fetchFn(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        return { ok: false, bucket: "transient", status: 0, message: String(e).slice(0, 200) };
      }

      const left = res.headers.get("x-ratelimit-remaining");
      if (left !== null) remaining = Number(left);

      const slug = slugInPath(path);
      // Reaching it again is the only proof that matters, and it is free. A 304
      // counts: GitHub answered it, which is the whole question.
      if (slug && (res.ok || res.status === 304) && holds.delete(slug)) clearEscalation(db, slug);

      if (res.status === 304 && hit) return { ok: true, status: 304, data: hit.data as T };

      const text = await res.text().catch(() => "");
      if (!res.ok) {
        const bucket = classify(res.status, text);
        const why = res.status === 404 ? unreachable(path) : `GitHub ${res.status} on ${path}: ${message(text)}`;
        // Only `boss` holds. A 502 or a secondary rate limit is `transient` and
        // backoff is what it is for — holding a project for a blip would stop a
        // fleet over something that fixes itself in seconds.
        if (bucket === "boss" && slug) holdRepo(db, lang, slug, why, Date.now());
        return { ok: false, status: res.status, bucket, message: why };
      }

      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        return { ok: false, status: res.status, bucket: "transient", message: `GitHub sent ${path} as something that is not JSON` };
      }

      const etag = res.headers.get("etag");
      if (method === "GET" && etag) {
        // ponytail: unbounded otherwise — every `since=` cursor is its own URL.
        // Entries are small and a restart clears it; a real LRU when it matters.
        if (cache.size > 500) cache.clear();
        cache.set(key, { etag, data });
      }
      return { ok: true, status: res.status, data: data as T };
    },
  };
}

/** GitHub's own words, when it left any. */
function message(text: string): string {
  try {
    const j = JSON.parse(text) as { message?: string; errors?: Array<{ message?: string }> };
    const extra = (j.errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
    return [j.message, extra].filter(Boolean).join(" — ").slice(0, 300) || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
