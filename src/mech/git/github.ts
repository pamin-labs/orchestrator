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
import { clearRepositoryHold, holdRepository } from "./repository.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import { errText } from "../../platform/process/text.ts";
import { activeTracer } from "../../platform/observability/traces.ts";
import type { Json } from "../../contracts/json.ts";
import { recordCache, recordRetry } from "../../platform/observability/metrics.ts";
import { currentRequestId, requestContext } from "../../platform/observability/request-context.ts";

/**
 * GitHub, as eight endpoints of ordinary JSON — over somebody else's transport.
 *
 * The eight endpoints are PR create / edit / view, checks, comments, reviews,
 * `/user` and one repo read, and their *shapes* are ours: every body is checked
 * against a Zod schema at the door, and the answer callers switch on is
 * `GhResult`, not an SDK's. What is emphatically not ours is the plumbing that
 * carries them — a retry loop, a backoff schedule, URL and body construction,
 * status decoding. That is commodity behaviour with a maintained owner, so
 * `@octokit/core` and `@octokit/plugin-retry` own it here.
 *
 * Not `@octokit/rest` or the batteries-included `octokit`: those exist to give
 * you a typed method per REST endpoint, and we call eight of them with our own
 * schemas. Not `gh` either — the point of 007 is that a host with docker, the
 * image and a pasted token can run, and every shelled-out binary is one more
 * thing that has to be installed and separately logged in.
 *
 * The credential is the one in `runtime_auth`, never a host CLI's login, and it
 * is read per request rather than handed to Octokit's `auth` option: the token
 * can be rotated under a live client, and it is also half the ETag cache key.
 * That distinction is what `test/one-model-path.test.ts` guards: two accounts
 * behind one label is how the fleet spent a night 401ing on a token the panel
 * could not see.
 */

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;
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
 * `@octokit/plugin-retry` waits `retryAfterBaseValue * attempt²`, which at 50ms
 * is 50ms then 200ms. Its `doNotRetry` default — 400, 401, 403, 404, 410, 422,
 * 451 — leaves 429 and the 5xx family, and a transport throw arrives as a
 * synthetic 500; that is the set this file used to spell out by hand.
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
   * Present only on a rate limit — from the `retry-after` header, or from the
   * `x-ratelimit-reset` clock for a primary limit. A scheduler that reschedules
   * this turn should prefer it over its own backoff, because it is the only
   * number in the exchange that GitHub actually chose.
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
/**
 * One HTTP answer, however Octokit chose to deliver it — return or throw.
 *
 * Deliberately a TypeScript type and not a Zod schema: this is not the trust
 * boundary, it is the shape of a library's own object. The boundary is the
 * *body*, and `data` stays `unknown` all the way to `decoded`, where `z.json()`
 * and the caller's endpoint schema are what let it into business code. A schema
 * here would have to wave the body through to be written at all, which looks
 * like validation and does none — see `test/governance/type-hygiene.test.ts`.
 */
type Answer = { status: number; headers: Record<string, unknown>; data: unknown };

/**
 * What we learned about one request while it was in flight.
 *
 * Keyed by the deadline signal, because **Octokit hands the plugins a copy of
 * our request options, not our object** — anything a plugin writes onto
 * `options.request` lands on the clone and is lost. The signal is a fresh object
 * per call that the copy passes through by reference, so it is the one usable
 * per-request identity. A `WeakMap` per client, so nothing is shared between
 * clients and nothing outlives the request.
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
 * which the retry plugin then treats as a retryable server error — so a
 * cancellation dressed as anything but this gets swallowed by the retry loop and
 * charged another attempt. A real `fetch` already names an abort this way; the
 * bridge below says it for an injected one.
 */
function abortError(signal: AbortSignal): Error {
  const error = new Error(String(signal.reason), { cause: signal.reason });
  error.name = "AbortError";
  return error;
}

/**
 * Our fetch, in the shape Octokit calls it.
 *
 * The abort check happens before the call as well as after it, because the
 * retry plugin schedules its backoff on Bottleneck, which knows nothing about
 * AbortSignal. Refusing at the door is what keeps a caller who cancelled during
 * a backoff from paying for one more request — the wait itself is no longer
 * interruptible, so cancellation is noticed up to one backoff late instead of
 * immediately.
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
 * Octokit throws for 304 and for every status past 399, so the non-2xx paths
 * this file cares about all arrive here rather than as a return value. Read by
 * shape rather than `instanceof`: importing `@octokit/request-error` to compare
 * against a second copy of the class is a version coincidence waiting to
 * happen, and this is the same check the retry plugin makes on its own errors.
 * No answer means the request never got one — a transport throw.
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

function observeResponse(state: GithubState, path: string, answer: Answer): void {
  const left = header(answer, "x-ratelimit-remaining");
  if (left !== null) state.remaining = Number(left);
  const slug = slugInPath(path);
  if (!slug) return;
  const ok = answer.status >= 200 && answer.status < 300;
  if (!ok && answer.status !== 304) return;
  if (clearRepositoryHold(slug)) clearEscalation(state.db, slug);
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
 * used — "secondary rate limit" decides a bucket. Re-serialising is what keeps
 * the sentence the boss ends up reading identical to the one this file produced
 * when it did its own parsing.
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

function httpFailure(state: GithubState, input: RequestInput<unknown>, answer: Answer): GhFail {
  const text = bodyText(answer.data);
  const bucket = classify(answer.status, text);
  const why =
    answer.status === 404 ? unreachable(input.path) : `GitHub ${answer.status} on ${input.path}: ${message(text)}`;
  const slug = slugInPath(input.path);
  if (bucket === "boss" && slug) holdRepo(state.db, state.lang, slug, why, Date.now());
  return failure(input.method, input.path, bucket, answer.status, why);
}

type Decoded<T> = GhFail | (GhOk<T> & { raw: Json });

/**
 * Octokit decodes by `content-type`; this endpoint set is JSON either way.
 *
 * GitHub labels its bodies correctly, so in production `data` is already parsed
 * and this is a no-op. A body that arrives as text — an error page, a proxy in
 * the middle, a stub that did not bother with the header — is still read as JSON
 * and still judged by the schema, which is what this file has always done. A
 * `content-type` is not the thing that makes an answer valid.
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
  // The eviction is `QuickLRU`'s, and the reason is the cache's own purpose. The
  // rule here used to be `clear()` on overflow, which throws the hot entries out
  // with the cold ones: every `since=` cursor is a distinct URL and single-use,
  // while a pull request's URL is re-read on every tick, so the moment the cursor
  // traffic tipped the count every open PR the poller was serving from a 304
  // went back to paying full price against the budget this cache exists to
  // protect. An LRU can tell the two apart; a size check cannot.
  state.cache.set(key, { etag, data });
}

function finish<T>(
  state: GithubState,
  input: RequestInput<T>,
  answer: Answer,
  key: string,
  hit: CacheEntry | undefined,
): GhResult<T> {
  observeResponse(state, input.path, answer);
  const cached = cachedResult(input, answer, hit);
  if (cached) return cached;
  if (answer.status >= 400) return httpFailure(state, input, answer);
  const value = decoded(input, answer);
  if (!value.ok) return value;
  storeCache(state, input, answer, key, value.raw);
  return { ok: true, status: value.status, data: value.data };
}

/**
 * The options object we hand Octokit.
 *
 * `retries` is `0 | undefined` on purpose, not `number`. A non-zero per-request
 * value bypasses the retry plugin's `doNotRetry` list entirely — measured: 404,
 * 401 and 422 each retried three times — because Bottleneck reads the count off
 * this object without asking whether the status was retryable. Reads take their
 * budget from the instance; writes are the only thing that sets this, to 0.
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
 * Returning `false` is what tells the plugin not to retry in band. The number is
 * filed against the request's signal because the `options` here are Octokit's
 * copy — writing onto them would be writing into a discarded object.
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
 * The raw path carries the repository name and the query string carries
 * cursors, both of which `docs/standards/observability.md` forbids on labels and
 * neither of which is bounded — one span name per pull request is a span table
 * nobody can group by. Owner, repository and every number become placeholders,
 * which leaves about a dozen distinct templates for the whole product.
 */
export const githubRoute = (path: string): string =>
  path
    .split("?")[0]!
    .replace(/^\/repos\/[^/]+\/[^/]+/, "/repos/{owner}/{repo}")
    .replace(/\/\d+(?=\/|$)/g, "/{n}");

async function requestGithub<T>(state: GithubState, input: RequestInput<T>): Promise<GhResult<T>> {
  return activeTracer().startActiveSpan(
    "github.request",
    { attributes: { "http.method": input.method, "http.route": githubRoute(input.path) } },
    async (span) => {
      try {
        const result = await requestGithubInner(state, input);
        // `requestGithub` reports failure by returning a `GhResult`, so a span
        // that errored only on a throw would stay green through a 500, a refused
        // credential and a rate limit alike. Measured before this landed: 18
        // calls to one route, 132.1s, and not one error row in the whole table.
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
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);
  if (callerSignal?.aborted) throw callerSignal.reason;

  const token = loadAuth(state.db, "github")?.secret;
  if (!token) return failure(input.method, input.path, "boss", 0, "no GitHub credential: connect GitHub in settings");
  const { key, hit } = cacheLookup(state, input, token);
  const sent = await send(state, input, token, hit, activeSignal);
  if (callerSignal?.aborted) throw callerSignal.reason;
  if (!("answer" in sent)) {
    return failure(input.method, input.path, "transient", 0, transportMessage(sent.error));
  }
  const result = finish(state, { ...input, callerSignal }, sent.answer, key, hit);
  // GitHub's own wait, when the throttling plugin found one, so a scheduler can
  // retry on its number rather than guessing at one.
  return result.ok || sent.retryAfter === undefined ? result : { ...result, retryAfter: sent.retryAfter };
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
   * rotated login must not reuse the previous one's cached bodies. Octokit has
   * no conditional-request plugin, so the cache identity stays ours; all it is
   * handed is the `if-none-match` header and the 304 it throws back.
   */
  const notes: Notes = new WeakMap();
  const kit = new GithubKit({
    baseUrl: API,
    userAgent: "orchestrator",
    request: { fetch: bridge(fetchFn, notes) },
    retry: { retries: RETRIES, retryAfterBaseValue: RETRY_BASE_MS },
    throttle: {
      /**
       * A fresh limiter per client, which is what stops one client's pacing
       * from queueing behind another's.
       *
       * `@octokit/plugin-throttling` reaches its limiters as
       * `state.write.key(state.id)`, and a `Bottleneck.Group` mints a separate
       * limiter per key — so the id is what isolates, not who owns the group.
       * Passing our own groups would only change the pacing numbers, and would
       * mean declaring `bottleneck` directly, whose last release is 2023-02-22
       * and so fails the maintenance rule in `docs/standards/dependencies.md`.
       * (The date here said 2019 until it was checked against npm. The
       * conclusion held; a wrong date in the reason is how a decision gets
       * reopened by someone who checks.)
       */
      id: crypto.randomUUID(),
      // Never wait in band. The plugin's own answer to a rate limit is to sleep
      // the caller for `retry-after` seconds — 60 by default — and try again,
      // which inside an agent turn holds a container open doing nothing. Saying
      // no here keeps today's behaviour exactly: the call returns promptly with
      // a `transient` bucket and the scheduler retries the turn later. What the
      // callback is really for is `retryAfter`, which is GitHub's own number and
      // reaches the caller on `GhFail` so that retry can be timed by it.
      onRateLimit: (retryAfter, options) => noteRetryAfter(notes, options, retryAfter),
      onSecondaryRateLimit: (retryAfter, options) => noteRetryAfter(notes, options, retryAfter),
    },
  });
  const state: GithubState = { db, kit, notes, lang, cache: new QuickLRU({ maxSize: CACHE_ENTRIES }), remaining: null };

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
