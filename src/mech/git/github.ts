import type { DB } from "../../platform/persistence/database.ts";
import { z } from "zod";
import { say } from "../../platform/text/lang.ts";
import { loadAuth } from "../sandbox/auth.ts";
import { raise } from "../flow/escalate.ts";
import { jsonOr } from "../../contracts/json.ts";
import { clearRepositoryHold, holdRepository } from "./repository.ts";
import type { Json } from "../../contracts/json.ts";
import { recordCache, recordRetry } from "../../observability.ts";
import { currentRequestId, requestContext } from "../../platform/observability/request-context.ts";

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
const JsonValue = z.json();
const ErrorBody = z.object({
  message: z.string().optional(),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return Bun.sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  const activeSignal = signal;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      activeSignal.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(activeSignal.reason);
    }
    activeSignal.addEventListener("abort", abort, { once: true });
  });
}

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
  operation?: string;
  target?: string;
  retryable?: boolean;
  correlationId?: string;
}
export interface GhOk<T> {
  ok: true;
  status: number;
  data: T;
}
export type GhResult<T> = GhOk<T> | GhFail;

/** Only the shape this uses, so a test stub is a `new Response(...)`. */
export type GithubFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export interface Github {
  request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: Json,
    signal?: AbortSignal,
  ): Promise<GhResult<T>>;
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
  holdRepository(slug, now);
  // `chain_state` matters as much as `answer`, and `raise` states it once for
  // every caller: `clearEscalation` revokes rather than answers, so a guard that
  // looks at `answer` alone treats a revoked question as still open — and a
  // project that recovered once could never file a second warning.
  raise(db, {
    // `why` goes in verbatim. It is the message built below, which deliberately
    // does not guess which of the four causes it was — and a wrapper that
    // "helpfully" summarised it as "token expired" would put the guess back.
    question: `GitHub ${slug}: ${why}\n\n${say(lang, "repo.held", { repo: slug })}`,
    brief: "GitHub 连不上了",
    kind: "env",
    // No agent can repair a project credential, and there is no group PM here.
    chain: "boss",
    dedupe: { prefix: `GitHub ${slug}:`, scope: "global" },
  });
}

/**
 * It works again, so take the question back.
 *
 * A boss who reconnects GitHub and watches the fleet resume should not also have
 * to dismiss a 待办 item about it. Revoked rather than answered: nobody answered
 * it, and `dropGroup` already uses `revoked` for a question the world made moot.
 */
export function clearEscalation(db: DB, slug: string): void {
  const prefix = `GitHub ${slug}:`;
  db.run(
    `UPDATE escalation SET chain_state = 'revoked', answered_at = unixepoch() * 1000
     WHERE answer IS NULL AND chain_state != 'revoked'
       AND substr(question, 1, length(?)) = ?`,
    [prefix, prefix],
  );
}

type CacheEntry = { etag: string; data: Json };
type GithubState = {
  db: DB;
  fetchFn: GithubFetcher;
  lang: string | undefined;
  cache: Map<string, CacheEntry>;
  remaining: number | null;
};
type RequestInput<T> = {
  method: string;
  path: string;
  schema: z.ZodType<T>;
  body: Json | undefined;
  callerSignal: AbortSignal | undefined;
};

function failure(method: string, path: string, bucket: Bucket, status: number, message: string): GhFail {
  return {
    ok: false,
    bucket,
    status,
    message,
    operation: `${method} GitHub API`,
    target: path,
    retryable: bucket === "transient",
    correlationId: currentRequestId(),
  };
}

function requestHeaders(token: string, hit: CacheEntry | undefined, hasBody: boolean): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "orchestrator",
    ...(hit ? { "if-none-match": hit.etag } : {}),
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };
}

async function fetchAttempt(
  fetchFn: GithubFetcher,
  url: string,
  init: Parameters<GithubFetcher>[1],
  callerSignal: AbortSignal | undefined,
  last: boolean,
): Promise<{ response: Response | undefined; error: unknown; done: boolean }> {
  try {
    const response = await fetchFn(url, init);
    return { response, error: undefined, done: ![429, 500, 502, 503, 504].includes(response.status) || last };
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    return { response: undefined, error, done: !!init.signal?.aborted || last };
  }
}

async function retryDelay(
  attempt: number,
  signal: AbortSignal | undefined,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  recordRetry("github");
  try {
    await sleep(50 * 2 ** attempt + Math.floor(Math.random() * 25), signal);
    return undefined;
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    return error;
  }
}

async function send(
  fetchFn: GithubFetcher,
  url: string,
  init: Parameters<GithubFetcher>[1],
  attempts: number,
  callerSignal?: AbortSignal,
): Promise<{ response: Response | undefined; error: unknown }> {
  let response: Response | undefined;
  let error: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await fetchAttempt(fetchFn, url, init, callerSignal, attempt === attempts - 1);
    if (result.response) response = result.response;
    if (result.error) error = result.error;
    if (result.done) break;
    const delayError = await retryDelay(attempt, init.signal, callerSignal);
    if (delayError) {
      error = delayError;
      break;
    }
  }
  if (callerSignal?.aborted) throw callerSignal.reason;
  return { response, error };
}

async function responseText(response: Response, callerSignal?: AbortSignal): Promise<string> {
  try {
    return await response.text();
  } catch {
    if (callerSignal?.aborted) throw callerSignal.reason;
    return "";
  }
}

function observeResponse(state: GithubState, path: string, response: Response): void {
  const left = response.headers.get("x-ratelimit-remaining");
  if (left !== null) state.remaining = Number(left);
  const slug = slugInPath(path);
  if (!slug) return;
  if (!response.ok && response.status !== 304) return;
  if (clearRepositoryHold(slug)) clearEscalation(state.db, slug);
}

function cachedResult<T>(input: RequestInput<T>, response: Response, hit: CacheEntry | undefined): GhResult<T> | null {
  if (response.status !== 304 || !hit) return null;
  const cached = input.schema.safeParse(hit.data);
  return cached.success
    ? { ok: true, status: 304, data: cached.data }
    : failure(input.method, input.path, "transient", 304, `GitHub cached invalid JSON for ${input.path}`);
}

function httpFailure(state: GithubState, input: RequestInput<unknown>, response: Response, text: string): GhFail {
  const bucket = classify(response.status, text);
  const why =
    response.status === 404 ? unreachable(input.path) : `GitHub ${response.status} on ${input.path}: ${message(text)}`;
  const slug = slugInPath(input.path);
  if (bucket === "boss" && slug) holdRepo(state.db, state.lang, slug, why, Date.now());
  return failure(input.method, input.path, bucket, response.status, why);
}

type Decoded<T> = GhFail | (GhOk<T> & { raw: Json });

function decoded<T>(input: RequestInput<T>, response: Response, text: string): Decoded<T> {
  let data: Json;
  try {
    data = JsonValue.parse(text ? JSON.parse(text) : null);
  } catch {
    return failure(
      input.method,
      input.path,
      "transient",
      response.status,
      `GitHub sent ${input.path} as something that is not JSON`,
    );
  }
  const parsed = input.schema.safeParse(data);
  return parsed.success
    ? { ok: true, status: response.status, data: parsed.data, raw: data }
    : failure(input.method, input.path, "transient", response.status, `GitHub sent invalid JSON for ${input.path}`);
}

function storeCache(
  state: GithubState,
  input: RequestInput<unknown>,
  response: Response,
  key: string,
  data: Json,
): void {
  const etag = response.headers.get("etag");
  if (input.method !== "GET" || !etag) return;
  // ponytail: unbounded otherwise — every `since=` cursor is its own URL.
  // Entries are small and a restart clears it; a real LRU when it matters.
  if (state.cache.size > 500) state.cache.clear();
  state.cache.set(key, { etag, data });
}

async function finish<T>(
  state: GithubState,
  input: RequestInput<T>,
  response: Response,
  key: string,
  hit: CacheEntry | undefined,
): Promise<GhResult<T>> {
  observeResponse(state, input.path, response);
  const cached = cachedResult(input, response, hit);
  if (cached) return cached;
  const text = await responseText(response, input.callerSignal);
  if (!response.ok) return httpFailure(state, input, response, text);
  const value = decoded(input, response, text);
  if (!value.ok) return value;
  storeCache(state, input, response, key, value.raw);
  return { ok: true, status: value.status, data: value.data };
}

function prepareRequest(
  state: GithubState,
  input: RequestInput<unknown>,
  token: string,
  signal: AbortSignal,
): { url: string; key: string; hit: CacheEntry | undefined; init: Parameters<GithubFetcher>[1]; attempts: number } {
  const url = input.path.startsWith("http") ? input.path : API + input.path;
  const key = `${token}\0${url}`;
  const hit = input.method === "GET" ? state.cache.get(key) : undefined;
  if (input.method === "GET") recordCache("github-etag", !!hit, state.cache.size);
  const init: Parameters<GithubFetcher>[1] = {
    method: input.method,
    headers: requestHeaders(token, hit, input.body !== undefined),
    signal,
  };
  if (input.body !== undefined) init.body = JSON.stringify(input.body);
  return { url, key, hit, init, attempts: input.method === "GET" ? 3 : 1 };
}

async function requestGithub<T>(state: GithubState, input: RequestInput<T>): Promise<GhResult<T>> {
  const callerSignal = input.callerSignal ?? requestContext.getStore()?.signal;
  const activeSignal = callerSignal
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);
  if (callerSignal?.aborted) throw callerSignal.reason;

  const token = loadAuth(state.db, "github")?.secret;
  if (!token) return failure(input.method, input.path, "boss", 0, "no GitHub credential: connect GitHub in settings");
  const prepared = prepareRequest(state, input, token, activeSignal);
  const sent = await send(state.fetchFn, prepared.url, prepared.init, prepared.attempts, callerSignal);
  if (!sent.response) return failure(input.method, input.path, "transient", 0, String(sent.error).slice(0, 200));
  return finish(state, { ...input, callerSignal }, sent.response, prepared.key, prepared.hit);
}

export function makeGithub(
  db: DB,
  fetchFn: GithubFetcher = fetch,
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
  const state: GithubState = { db, fetchFn, lang, cache: new Map(), remaining: null };

  return {
    remaining: () => state.remaining,

    async request<T>(
      method: string,
      path: string,
      schema: z.ZodType<T>,
      body?: Json,
      signal?: AbortSignal,
    ): Promise<GhResult<T>> {
      return requestGithub(state, { method, path, schema, body, callerSignal: signal });
    },
  };
}

/** GitHub's own words, when it left any. */
function message(text: string): string {
  const parsed = jsonOr(text, ErrorBody.nullable(), null);
  if (!parsed) return text.slice(0, 300);
  const extra = (parsed.errors ?? []).flatMap((e) => (e.message ? [e.message] : [])).join("; ");
  return [parsed.message, extra].filter(Boolean).join(" — ").slice(0, 300) || text.slice(0, 300);
}
