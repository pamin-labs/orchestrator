import type { DB } from "../../platform/persistence/database.ts";
import { Octokit } from "@octokit/core";
import QuickLRU from "quick-lru";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { z } from "zod";
import { say } from "../../platform/text/lang.ts";
import { loadAuth } from "../sandbox/auth.ts";
import { raise } from "../flow/escalate.ts";
import { jsonOr } from "../../contracts/json.ts";
import { and, isNull, ne, sql } from "drizzle-orm";
import { escalation } from "../../platform/persistence/schema.ts";
import { clearRepositoryHold, holdRepository } from "./repository.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import { errText } from "../../platform/process/text.ts";
import { ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_ROUTE } from "@opentelemetry/semantic-conventions";
import { activeTracer } from "../../platform/observability/traces.ts";
import type { Json } from "../../contracts/json.ts";
import { recordCache, recordRetry } from "../../platform/observability/metrics.ts";
import { currentRequestId, requestContext } from "../../platform/observability/request-context.ts";
import { DEFAULTS_FOR_CHECK as DEFAULTS } from "../../platform/config/load.ts";

/**
 * GitHub, as eight endpoints of ordinary JSON — over somebody else's transport.
 *
 * The *shapes* are ours: every body is Zod-checked at the door and callers switch
 * on `GhResult`, not an SDK's type. The plumbing is `@octokit/core`'s. The
 * credential is the one in `runtime_auth`, read per request rather than handed to
 * Octokit's `auth`: it can be rotated live, and it is half the ETag cache key.
 */

const API = "https://api.github.com";
/**
 * One GitHub call's wall clock, from `timeouts.githubApiMs`.
 *
 * Reads the config default rather than restating it; production passes the live
 * value in through `makeGithub`, so this number only ever applies where there is
 * no `Config` to ask — which today is the tests.
 */
const DEFAULT_TIMEOUT_MS = DEFAULTS.timeouts.githubApiMs;
/**
 * ETags kept, before the least recently used is dropped.
 *
 * No `maxAge`: a stale ETag costs one conditional request and never a wrong
 * answer, so time is the wrong axis to evict on. Entries are a URL and a hash.
 */
const CACHE_ENTRIES = 500;
/**
 * Two retries, so three attempts, and reads only.
 *
 * `@octokit/plugin-retry` waits `retryAfterBaseValue * attempt²`. Its `doNotRetry`
 * default leaves 429 and the 5xx family, and a transport throw arrives as a
 * synthetic 500.
 */
const RETRIES = 2;
const RETRY_BASE_MS = 50;
const GithubKit = Octokit.plugin(retry, throttling);
const JsonValue = z.json();
const ErrorBody = z.object({
  message: z.string().optional(),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

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
  /**
   * Seconds GitHub asked us to wait, when it said so.
   *
   * Present only on a rate limit — the `retry-after` header, or the
   * `x-ratelimit-reset` clock. A scheduler should prefer it over its own backoff:
   * it is the only number in the exchange that GitHub actually chose.
   */
  retryAfter?: number;
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
 * GitHub answers **404, not 403**, for a private repository a token cannot see, so
 * existence does not leak — and "repo deleted", "org revoked access", "user
 * removed from the org" and "token lost its scope" arrive identically. So this
 * says what is true, that the login cannot reach it, and lists what to check.
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
 * The agent bucket is mostly not errors at all — a merge conflict, a red check and
 * a review comment are 200s whose *body* says so, and `prwatch` reads them there.
 * What lands here is 422: GitHub understood the request and refused its content,
 * which is a fact about the branch rather than about the login.
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
async function holdRepo(db: DB, lang: string | undefined, slug: string, why: string, now: number): Promise<void> {
  holdRepository(slug, now);
  // `chain_state` matters as much as `answer`, and `raise` states it once for
  // every caller: `clearEscalation` revokes rather than answers, so a guard that
  // looks at `answer` alone treats a revoked question as still open — and a
  // project that recovered once could never file a second warning.
  await raise(db, {
    // `why` goes in verbatim. It is the message built below, which deliberately
    // does not guess which of the four causes it was — and a wrapper that
    // "helpfully" summarised it as "token expired" would put the guess back.
    question: `GitHub ${slug}: ${why}\n\n${say(lang, "ev.repo.held", { repo: slug })}`,
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
export async function clearEscalation(db: DB, slug: string): Promise<void> {
  const prefix = `GitHub ${slug}:`;
  await db
    .update(escalation)
    .set({ chain_state: "revoked", answered_at: Date.now() })
    .where(
      and(
        isNull(escalation.answer),
        ne(escalation.chain_state, "revoked"),
        // `starts_with`, not `like`: a repository named `my_repo` puts a LIKE
        // wildcard in the prefix, and the question it matches then belongs to a
        // different repository. Drizzle has no operator for an exact prefix.
        sql`starts_with(${escalation.question}, ${prefix})`,
      ),
    );
}

type CacheEntry = { etag: string; data: Json };
/**
 * One HTTP answer, however Octokit chose to deliver it — return or throw.
 *
 * Deliberately a TypeScript type and not a Zod schema: this is not the trust
 * boundary, it is the shape of a library's own object. The boundary is the *body*,
 * and `data` stays `unknown` all the way to `decoded`, where `z.json()` and the
 * caller's endpoint schema are what let it into business code.
 */
type Answer = { status: number; headers: Record<string, unknown>; data: unknown };

/**
 * What we learned about one request while it was in flight.
 *
 * Keyed by the deadline signal, because **Octokit hands the plugins a copy of our
 * request options, not our object** — anything a plugin writes onto
 * `options.request` lands on the clone and is lost. The signal is a fresh object
 * per call that the copy passes through by reference. A `WeakMap` per client.
 */
type Progress = { attempts: number; retryAfter?: number };
type Notes = WeakMap<AbortSignal, Progress>;

function noteOf(notes: Notes, signal: AbortSignal): Progress {
  const existing = notes.get(signal);
  if (existing) return existing;
  const fresh: Progress = { attempts: 0 };
  notes.set(signal, fresh);
  return fresh;
}
type GithubState = {
  db: DB;
  kit: InstanceType<typeof GithubKit>;
  notes: Notes;
  lang: string | undefined;
  timeoutMs: number;
  cache: QuickLRU<string, CacheEntry>;
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

function requestHeaders(token: string, hit: CacheEntry | undefined): Record<string, string> {
  return {
    // `@octokit/core` ignores an instance-level `headers` option — it reads only
    // `userAgent` and `timeZone` — so the two constants live here with the two
    // per-request ones. Content type and user agent are Octokit's to send.
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    ...(hit ? { "if-none-match": hit.etag } : {}),
  };
}

/**
 * The one rejection `@octokit/request` rethrows instead of wrapping.
 *
 * Everything else a fetch throws becomes a `RequestError` with a synthetic 500,
 * which the retry plugin treats as a retryable server error — so a cancellation
 * dressed as anything but this is swallowed by the retry loop and charged another
 * attempt. A real `fetch` names an abort this way; the bridge says it for a stub.
 */
function abortError(signal: AbortSignal): Error {
  const error = new Error(String(signal.reason), { cause: signal.reason });
  error.name = "AbortError";
  return error;
}

/**
 * Our fetch, in the shape Octokit calls it.
 *
 * The abort check happens before the call as well as after, because the retry
 * plugin schedules its backoff on Bottleneck, which knows nothing about
 * AbortSignal. The wait itself is not interruptible, so cancellation is noticed up
 * to one backoff late rather than never.
 */
function bridge(fetchFn: GithubFetcher, notes: Notes): GithubFetcher {
  return async (url, init) => {
    if (init.signal?.aborted) throw abortError(init.signal);
    // Counted here rather than read off the retry plugin's tally, which it
    // writes onto Octokit's copy of the options where we cannot see it. One
    // call per attempt, so everything past the first is a retry.
    if (init.signal) noteOf(notes, init.signal).attempts += 1;
    try {
      return await fetchFn(url, init);
    } catch (error) {
      if (init.signal?.aborted) throw abortError(init.signal);
      throw error;
    }
  };
}

/**
 * The HTTP answer inside a thrown `RequestError`, if there is one.
 *
 * Octokit throws for 304 and for every status past 399, so the non-2xx paths this
 * file cares about arrive here rather than as a return value. Read by shape rather
 * than `instanceof`: a second copy of the class is a version coincidence waiting
 * to happen. No answer means the request never got one — a transport throw.
 */
function answerOf(error: unknown): Answer | null {
  if (!(error instanceof Error) || !("response" in error)) return null;
  const response = error.response;
  if (typeof response !== "object" || response === null) return null;
  if (!("status" in response) || typeof response.status !== "number") return null;
  const headers = "headers" in response ? response.headers : null;
  return {
    status: response.status,
    headers: typeof headers === "object" && headers !== null ? { ...headers } : {},
    data: "data" in response ? response.data : undefined,
  };
}

function header(answer: Answer, name: string): string | null {
  const value = answer.headers[name];
  return typeof value === "string" ? value : null;
}

async function observeResponse(state: GithubState, path: string, answer: Answer): Promise<void> {
  const left = header(answer, "x-ratelimit-remaining");
  if (left !== null) state.remaining = Number(left);
  const slug = slugInPath(path);
  if (!slug) return;
  const ok = answer.status >= 200 && answer.status < 300;
  if (!ok && answer.status !== 304) return;
  if (clearRepositoryHold(slug)) await clearEscalation(state.db, slug);
}

function cachedResult<T>(input: RequestInput<T>, answer: Answer, hit: CacheEntry | undefined): GhResult<T> | null {
  if (answer.status !== 304 || !hit) return null;
  const cached = input.schema.safeParse(hit.data);
  return cached.success
    ? { ok: true, status: 304, data: cached.data }
    : failure(input.method, input.path, "transient", 304, `GitHub cached invalid JSON for ${input.path}`);
}

/**
 * The body as text, which is what `classify` and `message` read.
 *
 * Octokit hands back a decoded body, and both of those want the raw words GitHub
 * used — "secondary rate limit" decides a bucket.
 */
function bodyText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === undefined || data === null) return "";
  try {
    return JSON.stringify(data) ?? "";
  } catch {
    return "";
  }
}

async function httpFailure(state: GithubState, input: RequestInput<unknown>, answer: Answer): Promise<GhFail> {
  const text = bodyText(answer.data);
  const bucket = classify(answer.status, text);
  const why =
    answer.status === 404 ? unreachable(input.path) : `GitHub ${answer.status} on ${input.path}: ${message(text)}`;
  const slug = slugInPath(input.path);
  if (bucket === "boss" && slug) await holdRepo(state.db, state.lang, slug, why, Date.now());
  return failure(input.method, input.path, bucket, answer.status, why);
}

type Decoded<T> = GhFail | (GhOk<T> & { raw: Json });

/**
 * Octokit decodes by `content-type`; this endpoint set is JSON either way.
 *
 * A body that arrives as text — an error page, a proxy in the middle, a stub that
 * did not bother with the header — is still read as JSON and still judged by the
 * schema. A `content-type` is not the thing that makes an answer valid.
 */
function jsonBody(data: unknown): Json {
  if (data === undefined || data === "") return null;
  return JsonValue.parse(typeof data === "string" ? JSON.parse(data) : data);
}

function decoded<T>(input: RequestInput<T>, answer: Answer): Decoded<T> {
  let data: Json;
  try {
    data = jsonBody(answer.data);
  } catch {
    return failure(
      input.method,
      input.path,
      "transient",
      answer.status,
      `GitHub sent ${input.path} as something that is not JSON`,
    );
  }
  const parsed = input.schema.safeParse(data);
  return parsed.success
    ? { ok: true, status: answer.status, data: parsed.data, raw: data }
    : failure(input.method, input.path, "transient", answer.status, `GitHub sent invalid JSON for ${input.path}`);
}

function storeCache(state: GithubState, input: RequestInput<unknown>, answer: Answer, key: string, data: Json): void {
  const etag = header(answer, "etag");
  if (input.method !== "GET" || !etag) return;
  // `QuickLRU`, not `clear()` on overflow: every `since=` cursor is a distinct
  // single-use URL while a pull request's URL is re-read on every tick, so a size
  // check throws the hot entries out with the cold ones. An LRU tells them apart.
  state.cache.set(key, { etag, data });
}

async function finish<T>(
  state: GithubState,
  input: RequestInput<T>,
  answer: Answer,
  key: string,
  hit: CacheEntry | undefined,
): Promise<GhResult<T>> {
  await observeResponse(state, input.path, answer);
  const cached = cachedResult(input, answer, hit);
  if (cached) return cached;
  if (answer.status >= 400) return await httpFailure(state, input, answer);
  const value = decoded(input, answer);
  if (!value.ok) return value;
  storeCache(state, input, answer, key, value.raw);
  return { ok: true, status: value.status, data: value.data };
}

/**
 * The options object we hand Octokit.
 *
 * `retries` is `0 | undefined` on purpose, not `number`. A non-zero per-request
 * value bypasses the retry plugin's `doNotRetry` list entirely — measured: 404, 401
 * and 422 each retried three times — because Bottleneck reads the count off this
 * object without asking whether the status was retryable. Reads use the instance's.
 */
type RequestOptions = { signal: AbortSignal; retries?: 0 };

/**
 * One request, retries and all, as either an answer or the throw that stopped it.
 *
 * Writes carry `retries: 0` rather than a different plugin: retrying a PR
 * creation is how you get two of them. The read budget stays on the instance —
 * see `RequestOptions` for why it cannot be raised per request.
 */
async function send(
  state: GithubState,
  input: RequestInput<unknown>,
  token: string,
  hit: CacheEntry | undefined,
  signal: AbortSignal,
): Promise<({ answer: Answer } | { error: unknown }) & { retryAfter?: number }> {
  const options: RequestOptions = { signal };
  if (input.method !== "GET") options.retries = 0;
  const progress = noteOf(state.notes, signal);
  try {
    const response = await state.kit.request(`${input.method} ${input.path}`, {
      headers: requestHeaders(token, hit),
      ...(input.body === undefined ? {} : { data: input.body }),
      request: options,
    });
    return { answer: { status: response.status, headers: { ...response.headers }, data: response.data } };
  } catch (error) {
    const answer = answerOf(error);
    const waited = progress.retryAfter === undefined ? {} : { retryAfter: progress.retryAfter };
    return { ...(answer ? { answer } : { error }), ...waited };
  } finally {
    // Every attempt past the first was a retry.
    for (let i = 1; i < progress.attempts; i++) recordRetry("github");
  }
}

/** The cache identity: the URL Octokit will build, and the login that asked. */
function cacheLookup(
  state: GithubState,
  input: RequestInput<unknown>,
  token: string,
): { key: string; hit: CacheEntry | undefined } {
  const url = input.path.startsWith("http") ? input.path : API + input.path;
  const key = `${token}\0${url}`;
  if (input.method !== "GET") return { key, hit: undefined };
  const hit = state.cache.get(key);
  recordCache("github-etag", !!hit, state.cache.size);
  return { key, hit };
}

/**
 * Keep GitHub's own wait, and decline to sleep on it.
 *
 * Returning `false` tells the plugin not to retry in band. The number is filed
 * against the request's signal because the `options` here are Octokit's copy —
 * writing onto them would be writing into a discarded object.
 */
function noteRetryAfter(notes: Notes, options: { request?: unknown }, retryAfter: number): false {
  const request = options.request;
  const signal = typeof request === "object" && request !== null && "signal" in request ? request.signal : null;
  if (signal instanceof AbortSignal) noteOf(notes, signal).retryAfter = retryAfter;
  return false;
}

/** The original throw, not Octokit's wrapper: `@octokit/request` keeps it as
 *  `cause`, and it is the half that says what actually happened. */
function transportMessage(thrown: unknown): string {
  const cause = thrown instanceof Error && thrown.cause !== undefined ? thrown.cause : thrown;
  return String(cause).slice(0, 200);
}

/**
 * A GitHub path as a bounded label.
 *
 * The raw path carries the repository name and the query string carries cursors,
 * both forbidden on labels by `docs/standards/observability.md` and neither
 * bounded. Owner, repository and every number become placeholders, which leaves
 * about a dozen distinct templates for the whole product.
 */
export const githubRoute = (path: string): string =>
  path
    .split("?")[0]!
    .replace(/^\/repos\/[^/]+\/[^/]+/, "/repos/{owner}/{repo}")
    .replace(/\/\d+(?=\/|$)/g, "/{n}");

async function requestGithub<T>(state: GithubState, input: RequestInput<T>): Promise<GhResult<T>> {
  return activeTracer().startActiveSpan(
    "github.request",
    // The constants, not literals: this span and the HTTP server's landed in one
    // table under two different keys for the same fact — `http.method` here has
    // been deprecated in favour of `http.request.method` — so a GROUP BY over the
    // span table split every route in half.
    { attributes: { [ATTR_HTTP_REQUEST_METHOD]: input.method, [ATTR_HTTP_ROUTE]: githubRoute(input.path) } },
    async (span) => {
      try {
        const result = await requestGithubInner(state, input);
        // `requestGithub` reports failure by returning a `GhResult`, so a span that
        // errored only on a throw would stay green through a 500, a refused
        // credential and a rate limit alike.
        if (!result.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: `${result.status} ${result.bucket}` });
        return result;
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: errText(e) });
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

async function requestGithubInner<T>(state: GithubState, input: RequestInput<T>): Promise<GhResult<T>> {
  const callerSignal = input.callerSignal ?? requestContext.getStore()?.signal;
  const activeSignal = callerSignal
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(state.timeoutMs)])
    : AbortSignal.timeout(state.timeoutMs);
  if (callerSignal?.aborted) throw callerSignal.reason;

  const token = (await loadAuth(state.db, "github"))?.secret;
  if (!token) return failure(input.method, input.path, "boss", 0, "no GitHub credential: connect GitHub in settings");
  const { key, hit } = cacheLookup(state, input, token);
  const sent = await send(state, input, token, hit, activeSignal);
  if (callerSignal?.aborted) throw callerSignal.reason;
  if (!("answer" in sent)) {
    return failure(input.method, input.path, "transient", 0, transportMessage(sent.error));
  }
  const result = await finish(state, { ...input, callerSignal }, sent.answer, key, hit);
  // GitHub's own wait, when the throttling plugin found one, so a scheduler can
  // retry on its number rather than guessing at one.
  return result.ok || sent.retryAfter === undefined ? result : { ...result, retryAfter: sent.retryAfter };
}

export function makeGithub(
  db: DB,
  fetchFn: GithubFetcher = fetch,
  /** `output.language`, for the one sentence the boss reads. */
  lang?: string,
  /** `timeouts.githubApiMs`. Omitted only where there is no `Config` to read. */
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Github {
  /**
   * ETags, keyed by token as well as URL.
   *
   * A 304 does **not** count against the primary rate limit, and `pollPrs` runs
   * every tick against every open PR. Keyed by the token because a rotated login
   * must not reuse the previous one's cached bodies. Octokit has no
   * conditional-request plugin, so the cache identity stays ours.
   */
  const notes: Notes = new WeakMap();
  const kit = new GithubKit({
    baseUrl: API,
    userAgent: "orchestrator",
    request: { fetch: bridge(fetchFn, notes) },
    retry: { retries: RETRIES, retryAfterBaseValue: RETRY_BASE_MS },
    throttle: {
      /**
       * A fresh limiter per client, which is what stops one client's pacing from
       * queueing behind another's.
       *
       * `@octokit/plugin-throttling` reaches its limiters as
       * `state.write.key(state.id)`, and a `Bottleneck.Group` mints a separate
       * limiter per key — so the id is what isolates, not who owns the group.
       */
      id: crypto.randomUUID(),
      // Never wait in band. The plugin's own answer to a rate limit is to sleep the
      // caller for `retry-after` seconds and try again, which inside an agent turn
      // holds a container open doing nothing; saying no returns promptly with a
      // `transient` bucket and the scheduler retries the turn later. What the
      // callback is really for is `retryAfter`, GitHub's own number, which reaches
      // the caller on `GhFail`.
      onRateLimit: (retryAfter, options) => noteRetryAfter(notes, options, retryAfter),
      onSecondaryRateLimit: (retryAfter, options) => noteRetryAfter(notes, options, retryAfter),
    },
  });
  const state: GithubState = {
    db,
    kit,
    notes,
    lang,
    timeoutMs,
    cache: new QuickLRU({ maxSize: CACHE_ENTRIES }),
    remaining: null,
  };

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
