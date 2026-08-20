import { expect, test } from "bun:test";
import { HttpResponse, delay, http } from "msw";
import { z } from "zod";
import type { Json } from "../../src/contracts/json.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { saveAuth } from "../../src/mech/sandbox/auth.ts";
import { classify, githubRoute, makeGithub, type GithubFetcher } from "../../src/mech/git/github.ts";
import { parseRepo } from "../../src/contracts/repository.ts";
import { server, mockHttp } from "../support/http.ts";

/**
 * The REST client, without the network — but with everything under it.
 *
 * These used to substitute `fetch` outright, which meant the half worth testing
 * was never reached: the retry budget, the `doNotRetry` list, the backoff, the
 * conditional request and the two rate-limit callbacks all belong to
 * `@octokit/core` and its plugins, and a stub returning a `Response` decides those
 * itself. MSW intercepts below `fetch`, so each request goes through the real path.
 */
/**
 * `onUnhandledRequest: "error"` is what makes that safe: a URL nobody wrote a
 * handler for fails rather than reaching github.com.
 *
 * `makeGithub(db)` with no second argument is deliberate — the default is the
 * global `fetch`, which is what production uses and what MSW intercepts. The one
 * test that still injects a fetcher does so because its subject is that seam.
 */

mockHttp();

const API = "https://api.github.com";

async function db(token = "ghp_one") {
  const d = await openMemory();
  await saveAuth(d, { runtime: "github", mode: "api_key", secret: token });
  return d;
}

const json = (status: number, body: Json, headers: Record<string, string> = {}) =>
  status === 304 ? new HttpResponse(null, { status, headers }) : HttpResponse.json(body, { status, headers });

test("a 404 says the login cannot reach it, and never that the repo was deleted", async () => {
  // GitHub answers 404 rather than 403 for a private repo a token cannot see, so
  // "deleted", "org revoked access", "removed from the org" and "lost its scope"
  // are the same response. Naming one of them sends the boss to the wrong page.
  server.use(http.get(`${API}/repos/me/gone`, () => json(404, { message: "Not Found" })));
  const r = await makeGithub(await db()).request("GET", "/repos/me/gone", z.json());
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.bucket).toBe("boss");
  expect(r.message).toContain("can no longer reach");
  expect(r.message).toContain("me/gone");
  for (const claim of ["deleted", "was removed", "no longer exists", "has been"]) {
    expect(r.message.toLowerCase()).not.toContain(claim);
  }
  // And it does list what to actually check.
  expect(r.message).toContain("renam");
  expect(r.message).toContain("organisation");
});

test("a 304 costs nothing and hands back the body we already had", async () => {
  // A 304 does not count against the primary rate limit, which is the whole
  // reason for the ETag: pollPrs runs against every open PR every tick.
  const sent: Array<string | null> = [];
  let hits = 0;
  server.use(
    http.get(`${API}/repos/me/x/pulls/7`, ({ request }) => {
      sent.push(request.headers.get("if-none-match"));
      hits++;
      return hits === 1
        ? json(200, { number: 7 }, { etag: 'W/"abc"', "x-ratelimit-remaining": "4999" })
        : json(304, null, { etag: 'W/"abc"', "x-ratelimit-remaining": "4999" });
    }),
  );
  const gh = makeGithub(await db());
  const Pull = z.object({ number: z.number() });
  const first = await gh.request("GET", "/repos/me/x/pulls/7", Pull);
  const second = await gh.request("GET", "/repos/me/x/pulls/7", Pull);

  expect(first.ok && first.data.number).toBe(7);
  expect(second.ok && second.status).toBe(304);
  // The body is the cached one — a 304 carries none.
  expect(second.ok && second.data.number).toBe(7);
  expect(sent).toEqual([null, 'W/"abc"']);
  expect(gh.remaining()).toBe(4999);
});

test("an ETag caches raw JSON so each caller can apply its own schema", async () => {
  let hits = 0;
  server.use(
    http.get(`${API}/repos/me/x`, () =>
      ++hits === 1 ? json(200, { a: 1, b: 2 }, { etag: 'W/"shape"' }) : json(304, null, { etag: 'W/"shape"' }),
    ),
  );
  const gh = makeGithub(await db());

  expect((await gh.request("GET", "/repos/me/x", z.object({ a: z.number() }))).ok).toBe(true);
  const second = await gh.request("GET", "/repos/me/x", z.object({ b: z.number() }));
  expect(second.ok && second.data.b).toBe(2);
});

test("JSON that misses the endpoint schema is a handled transient failure", async () => {
  server.use(http.get(`${API}/repos/me/x`, () => json(200, null)));
  const r = await makeGithub(await db()).request(
    "GET",
    "/repos/me/x",
    z.object({ full_name: z.string(), default_branch: z.string(), clone_url: z.string() }),
  );

  expect(r).toMatchObject({ ok: false, status: 200, bucket: "transient" });
});

test("rotating the login invalidates the ETags rather than reusing them", async () => {
  // Cached per token, not per URL: a new login must not be handed the previous
  // one's answers, and must not send its ETag either.
  const sent: Array<string | null> = [];
  const d = await db("ghp_one");
  server.use(
    http.get(`${API}/user`, ({ request }) => {
      sent.push(request.headers.get("if-none-match"));
      const authorization = request.headers.get("authorization");
      if (!authorization) throw new Error("missing authorization fixture");
      return json(200, { login: authorization }, { etag: 'W/"abc"' });
    }),
  );
  const gh = makeGithub(d);
  await gh.request("GET", "/user", z.json());
  await gh.request("GET", "/user", z.json());
  expect(sent).toEqual([null, 'W/"abc"']);

  await saveAuth(d, { runtime: "github", mode: "api_key", secret: "ghp_two" });
  const after = await gh.request("GET", "/user", z.object({ login: z.string() }));
  expect(sent[2]).toBeNull();
  expect(after.ok && after.data.login).toContain("ghp_two");
});

test("the three buckets are the three different answers", () => {
  // boss: nothing an agent or a retry can do.
  expect(classify(401, "Bad credentials")).toBe("boss");
  expect(classify(403, "Resource not accessible by integration")).toBe("boss");
  expect(classify(404, "Not Found")).toBe("boss");
  // transient: back off and it may well work.
  expect(classify(0, "TypeError: fetch failed")).toBe("transient");
  expect(classify(500, "")).toBe("transient");
  expect(classify(502, "bad gateway")).toBe("transient");
  expect(classify(429, "")).toBe("transient");
  // The one 403 that is not the boss's: a secondary rate limit says so in the
  // body, and holding the whole project for it would be wrong.
  expect(classify(403, "You have exceeded a secondary rate limit")).toBe("transient");
  // agent: GitHub understood us and refused the content.
  expect(classify(422, "No commits between main and orch/g1")).toBe("agent");
});

test("a network throw is transient, not a bad credential", async () => {
  let attempts = 0;
  server.use(
    http.get(`${API}/user`, () => {
      attempts += 1;
      // A real transport failure, produced by the interceptor rather than
      // described by a stub — which is what proves the retry plugin treats one
      // as retryable and this file turns it into a status-less transient.
      return HttpResponse.error();
    }),
  );
  const r = await makeGithub(await db()).request("GET", "/user", z.json());
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.bucket).toBe("transient");
    expect(r.status).toBe(0);
  }
  expect(attempts).toBe(3);
});

test("transient retries are bounded and only used for idempotent reads", async () => {
  let gets = 0;
  server.use(
    http.get(`${API}/user`, () => {
      gets += 1;
      return gets < 3 ? json(502, { message: "bad gateway" }) : json(200, { ok: true });
    }),
  );
  const get = await makeGithub(await db()).request("GET", "/user", z.object({ ok: z.boolean() }));
  expect(get.ok).toBe(true);
  expect(gets).toBe(3);

  let posts = 0;
  server.use(
    http.post(`${API}/repos/me/x/pulls`, () => {
      posts += 1;
      return json(502, { message: "bad gateway" });
    }),
  );
  const post = await makeGithub(await db()).request("POST", "/repos/me/x/pulls", z.json(), { title: "x" });
  expect(post).toMatchObject({ ok: false, status: 502, bucket: "transient" });
  expect(posts).toBe(1);
});

test("every GitHub request carries a deadline signal", async () => {
  // The one test here that still injects a fetcher, because the signal handed to
  // *our* fetch is exactly what it is about: Octokit copies the request options
  // it is given, and a deadline that did not survive that copy would be invisible
  // from outside. MSW answers requests; it cannot say what Octokit passed down.
  const d = await db();
  let deadline: AbortSignal | undefined;
  const fetchFn: GithubFetcher = async (_url, init) => {
    deadline = init.signal;
    return Response.json({ login: "octocat" });
  };
  const result = await makeGithub(d, fetchFn).request("GET", "/user", z.object({ login: z.string() }));

  expect(result.ok).toBe(true);
  expect(deadline).toBeInstanceOf(AbortSignal);
  expect(deadline!.aborted).toBe(false);
});

test("a real fetch names an abort AbortError, which is the one throw Octokit rethrows", async () => {
  // The assumption the whole cancellation path rests on, and until now only an
  // injected fetch ever said it. `@octokit/request` wraps every other rejection
  // into a `RequestError` with a synthetic 500, which the retry plugin then
  // treats as a retryable server error — so if the platform named an abort
  // anything else, a cancelled request would be retried twice more and report
  // GitHub's failure instead of the caller's cancellation.
  server.use(
    http.get(`${API}/user`, async () => {
      await delay("infinite");
      return json(200, {});
    }),
  );
  const controller = new AbortController();
  const inflight = fetch(`${API}/user`, { signal: controller.signal });
  controller.abort();
  const error = await inflight.catch((thrown: unknown) => thrown);
  expect(error instanceof Error && error.name).toBe("AbortError");
});

test("caller cancellation aborts an active GitHub request without retrying", async () => {
  const d = await db();
  const controller = new AbortController();
  let attempts = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  server.use(
    http.get(`${API}/user`, async () => {
      attempts += 1;
      entered();
      // Never answered, so the only thing that can end this request is the
      // abort — through the real `fetch`, not a stub imitating one.
      await delay("infinite");
      return json(200, {});
    }),
  );
  const result = makeGithub(d).request("GET", "/user", z.json(), undefined, controller.signal);

  await started;
  const reason = new Error("caller stopped");
  controller.abort(reason);
  expect(await result.catch((error: unknown) => error)).toBe(reason);
  expect(attempts).toBe(1);
});

test("cancelling during a retry backoff costs no further request", async () => {
  // The backoff belongs to `@octokit/plugin-retry` now, which schedules it on
  // Bottleneck and knows nothing about an AbortSignal. So the cancellation is
  // checked at the door of every attempt rather than only around the wait: a
  // retry that ran anyway would spend a request on an answer nobody is waiting
  // for, and would report GitHub's failure instead of the caller's cancellation.
  const d = await db();
  const controller = new AbortController();
  const reason = new Error("caller stopped");
  let attempts = 0;
  server.use(
    http.get(`${API}/user`, () => {
      attempts += 1;
      // Retryable, so a retry is scheduled — and cancelled before it fires.
      // After the answer is handed back rather than during it, so what is
      // under test is the backoff and not the response read.
      queueMicrotask(() => controller.abort(reason));
      return json(502, { message: "bad gateway" });
    }),
  );
  const result = makeGithub(d).request("GET", "/user", z.json(), undefined, controller.signal);

  expect(await result.catch((error: unknown) => error)).toBe(reason);
  expect(attempts).toBe(1);
});

test("a secondary rate limit hands back GitHub's own wait, and does not sit on it", async () => {
  // The throttling plugin's own answer to this is to sleep the caller for
  // `retry-after` seconds — 60 when GitHub names none — and try again, which
  // inside an agent turn holds a container open doing nothing. We decline the
  // sleep and keep the number: the scheduler can retry on GitHub's schedule
  // instead of guessing, which is the whole reason the plugin is installed.
  const d = await db();
  const started = Date.now();
  server.use(
    http.get(`${API}/repos/me/x/pulls/7`, () =>
      json(403, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "42" }),
    ),
  );
  const r = await makeGithub(d).request("GET", "/repos/me/x/pulls/7", z.json());

  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.retryAfter).toBe(42);
  // Still the answer it always was: waited out, not the boss's problem.
  expect(r.bucket).toBe("transient");
  expect(r.status).toBe(403);
  // Promptly. A retry accepted in band would have parked here for 42 seconds.
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a primary rate limit dates the wait from the reset clock", async () => {
  // No `retry-after` on a primary limit — GitHub gives an epoch to wait until,
  // and the plugin reads it off `x-ratelimit-reset` once `remaining` hits zero.
  const d = await db();
  const reset = Math.ceil(Date.now() / 1000) + 30;
  server.use(
    http.get(`${API}/repos/me/x/pulls/7`, () =>
      json(
        403,
        { message: "API rate limit exceeded" },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      ),
    ),
  );
  const r = await makeGithub(d).request("GET", "/repos/me/x/pulls/7", z.json());

  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  // Give or take the second the test spent getting here.
  expect(r.retryAfter).toBeGreaterThan(25);
  expect(r.retryAfter).toBeLessThanOrEqual(32);
  expect(r.bucket).toBe("transient");
});

test("a status the retry plugin will not retry is asked exactly once", async () => {
  // The landmine this guards: a non-zero per-request `retries` bypasses the
  // plugin's `doNotRetry` list, because Bottleneck reads the count off the
  // options object without asking whether the status was retryable. Measured,
  // it retries these three times each — burning the rate limit on answers that
  // will not change, and holding the repository three times over.
  for (const status of [404, 401, 422]) {
    const d = await db();
    let attempts = 0;
    server.use(
      http.get(`${API}/repos/me/x`, () => {
        attempts += 1;
        return json(status, { message: "no" });
      }),
    );
    await makeGithub(d).request("GET", "/repos/me/x", z.json());
    expect({ status, attempts }).toEqual({ status, attempts: 1 });
  }
});

test("no credential is the boss's, and nothing is sent", async () => {
  let called = 0;
  server.use(
    http.get(`${API}/user`, () => {
      called += 1;
      return json(200, {});
    }),
  );
  const r = await makeGithub(await openMemory()).request("GET", "/user", z.json());
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.bucket).toBe("boss");
  expect(called).toBe(0);
});

test("a URL nobody wrote a handler for fails instead of reaching github.com", async () => {
  // The evidence for the `onUnhandledRequest: "error"` row in
  // `docs/standards/enforcement-matrix.md`, and the reason it is a row at all.
  // Weakened to "warn" or "bypass" this suite would quietly start talking to
  // github.com from CI and from every contributor's laptop, and the only symptom
  // would be a test that fails on an aeroplane. The one line of MSW output below
  // is what that costs.
  // oxlint-disable-next-line typescript/await-thenable -- Bun's async matcher is awaitable, but Matchers is not declared Thenable
  await expect(fetch(`${API}/repos/me/nobody-handled-this`)).rejects.toThrow();
});

test("owner/repo comes out of whatever shape the remote is in", () => {
  expect(parseRepo("git@github.com:me/x.git")).toBe("me/x");
  expect(parseRepo("https://github.com/me/x.git")).toBe("me/x");
  expect(parseRepo("https://github.com/me/x")).toBe("me/x");
  expect(parseRepo("ssh://git@github.com/me/x.git")).toBe("me/x");
  expect(parseRepo("git@gitlab.com:me/x.git")).toBeNull();
});

/**
 * An owner is never invented from a directory name.
 *
 * What survived `slugRepoPaths`, the SQLite-era repair that turned an absolute
 * `repo_path` into `owner/name`. The repair went with the migration ladder (038);
 * the decision inside it did not, because a guessed owner points the fleet at
 * somebody else's repository — and none of these three is guessable.
 */
test("a remote nobody can turn into owner/repo is refused rather than guessed", () => {
  expect(parseRepo("/Users/jason/code/orchestrator")).toBeNull();
  expect(parseRepo("")).toBeNull();
  expect(parseRepo("git@gitlab.com:me/c.git")).toBeNull();
});

/**
 * A span label has to be groupable, and a repository name is neither.
 *
 * `docs/standards/observability.md` forbids repository paths on labels, and the
 * cardinality argument is the same point from the other side: one span name per
 * pull request is a table nobody can aggregate. The templates below are the
 * whole product's GitHub surface — about a dozen of them.
 */
test("a GitHub path becomes a route template, not a repository name", () => {
  expect(githubRoute("/repos/pamin-labs/orchestrator/pulls/12")).toBe("/repos/{owner}/{repo}/pulls/{n}");
  expect(githubRoute("/repos/pamin-labs/orchestrator/pulls/12/reviews?per_page=100")).toBe(
    "/repos/{owner}/{repo}/pulls/{n}/reviews",
  );
  expect(githubRoute("/repos/pamin-labs/orchestrator")).toBe("/repos/{owner}/{repo}");
  // Cursors are the unbounded half: `?page=` walks every page of every repo.
  expect(githubRoute("/installation/repositories?per_page=100&page=7")).toBe("/installation/repositories");
  // Nothing to redact, nothing changed.
  expect(githubRoute("/user")).toBe("/user");
});
