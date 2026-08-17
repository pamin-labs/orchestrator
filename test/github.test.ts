import { expect, test } from "bun:test";
import { z } from "zod";
import type { Json } from "../src/contracts/json.ts";
import { openMemory } from "../src/platform/persistence/database.ts";
import { saveAuth } from "../src/mech/sandbox/auth.ts";
import { classify, makeGithub, type GithubFetcher } from "../src/mech/git/github.ts";
import { parseRepo } from "../src/contracts/repository.ts";

/**
 * The REST client, without the network.
 *
 * Everything here is a stubbed `fetch`: the point of injecting one is that a
 * check for "does a 304 reuse the body" must not depend on GitHub being up, or
 * on this machine having a token.
 */

function db(token = "ghp_one") {
  const d = openMemory();
  saveAuth(d, { runtime: "github", mode: "api_key", secret: token });
  return d;
}

const json = (status: number, body: Json, headers: Record<string, string> = {}) =>
  new Response(status === 304 ? null : JSON.stringify(body), { status, headers });

test("a 404 says the login cannot reach it, and never that the repo was deleted", async () => {
  // GitHub answers 404 rather than 403 for a private repo a token cannot see, so
  // "deleted", "org revoked access", "removed from the org" and "lost its scope"
  // are the same response. Naming one of them sends the boss to the wrong page.
  const fetchFn: GithubFetcher = async () => json(404, { message: "Not Found" });
  const r = await makeGithub(db(), fetchFn).request("GET", "/repos/me/gone", z.json());
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
  const sent: Array<string | undefined> = [];
  let hits = 0;
  const fetchFn: GithubFetcher = async (_url, init) => {
    sent.push(init.headers["if-none-match"]);
    hits++;
    return hits === 1
      ? json(200, { number: 7 }, { etag: 'W/"abc"', "x-ratelimit-remaining": "4999" })
      : json(304, null, { etag: 'W/"abc"', "x-ratelimit-remaining": "4999" });
  };
  const gh = makeGithub(db(), fetchFn);
  const Pull = z.object({ number: z.number() });
  const first = await gh.request("GET", "/repos/me/x/pulls/7", Pull);
  const second = await gh.request("GET", "/repos/me/x/pulls/7", Pull);

  expect(first.ok && first.data.number).toBe(7);
  expect(second.ok && second.status).toBe(304);
  // The body is the cached one — a 304 carries none.
  expect(second.ok && second.data.number).toBe(7);
  expect(sent).toEqual([undefined, 'W/"abc"']);
  expect(gh.remaining()).toBe(4999);
});

test("an ETag caches raw JSON so each caller can apply its own schema", async () => {
  let hits = 0;
  const gh = makeGithub(db(), async () =>
    ++hits === 1 ? json(200, { a: 1, b: 2 }, { etag: 'W/"shape"' }) : json(304, null, { etag: 'W/"shape"' }),
  );

  expect((await gh.request("GET", "/repos/me/x", z.object({ a: z.number() }))).ok).toBe(true);
  const second = await gh.request("GET", "/repos/me/x", z.object({ b: z.number() }));
  expect(second.ok && second.data.b).toBe(2);
});

test("JSON that misses the endpoint schema is a handled transient failure", async () => {
  const r = await makeGithub(db(), async () => json(200, null)).request(
    "GET",
    "/repos/me/x",
    z.object({ full_name: z.string(), default_branch: z.string(), clone_url: z.string() }),
  );

  expect(r).toMatchObject({ ok: false, status: 200, bucket: "transient" });
});

test("rotating the login invalidates the ETags rather than reusing them", async () => {
  // Cached per token, not per URL: a new login must not be handed the previous
  // one's answers, and must not send its ETag either.
  const sent: Array<string | undefined> = [];
  const d = db("ghp_one");
  const fetchFn: GithubFetcher = async (_url, init) => {
    sent.push(init.headers["if-none-match"]);
    const authorization = init.headers.authorization;
    if (!authorization) throw new Error("missing authorization fixture");
    return json(200, { login: authorization }, { etag: 'W/"abc"' });
  };
  const gh = makeGithub(d, fetchFn);
  await gh.request("GET", "/user", z.json());
  await gh.request("GET", "/user", z.json());
  expect(sent).toEqual([undefined, 'W/"abc"']);

  saveAuth(d, { runtime: "github", mode: "api_key", secret: "ghp_two" });
  const after = await gh.request("GET", "/user", z.object({ login: z.string() }));
  expect(sent[2]).toBeUndefined();
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
  const fetchFn: GithubFetcher = async () => {
    attempts += 1;
    throw new TypeError("fetch failed");
  };
  const r = await makeGithub(db(), fetchFn).request("GET", "/user", z.json());
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.bucket).toBe("transient");
    expect(r.status).toBe(0);
  }
  expect(attempts).toBe(3);
});

test("transient retries are bounded and only used for idempotent reads", async () => {
  let gets = 0;
  const get = await makeGithub(db(), async () => {
    gets += 1;
    return gets < 3 ? json(502, { message: "bad gateway" }) : json(200, { ok: true });
  }).request("GET", "/user", z.object({ ok: z.boolean() }));
  expect(get.ok).toBe(true);
  expect(gets).toBe(3);

  let posts = 0;
  const post = await makeGithub(db(), async () => {
    posts += 1;
    return json(502, { message: "bad gateway" });
  }).request("POST", "/repos/me/x/pulls", z.json(), { title: "x" });
  expect(post).toMatchObject({ ok: false, status: 502, bucket: "transient" });
  expect(posts).toBe(1);
});

test("every GitHub request carries a deadline signal", async () => {
  const d = db();
  try {
    let deadline: AbortSignal | undefined;
    const result = await makeGithub(d, async (_url, init) => {
      deadline = init.signal;
      return json(200, { login: "octocat" });
    }).request("GET", "/user", z.object({ login: z.string() }));

    expect(result.ok).toBe(true);
    expect(deadline).toBeInstanceOf(AbortSignal);
    expect(deadline!.aborted).toBe(false);
  } finally {
    d.close();
  }
});

test("caller cancellation aborts an active GitHub request without retrying", async () => {
  const d = db();
  try {
    const controller = new AbortController();
    let attempts = 0;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const result = makeGithub(d, async (_url, init) => {
      attempts += 1;
      const signal = init.signal;
      if (!signal) throw new Error("missing deadline signal");
      entered();
      return await new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }).request("GET", "/user", z.json(), undefined, controller.signal);

    await started;
    const reason = new Error("caller stopped");
    controller.abort(reason);
    expect(await result.catch((error: unknown) => error)).toBe(reason);
    expect(attempts).toBe(1);
  } finally {
    d.close();
  }
});

test("no credential is the boss's, and nothing is sent", async () => {
  let called = false;
  const fetchFn: GithubFetcher = async () => {
    called = true;
    return json(200, {});
  };
  const r = await makeGithub(openMemory(), fetchFn).request("GET", "/user", z.json());
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.bucket).toBe("boss");
  expect(called).toBe(false);
});

test("owner/repo comes out of whatever shape the remote is in", () => {
  expect(parseRepo("git@github.com:me/x.git")).toBe("me/x");
  expect(parseRepo("https://github.com/me/x.git")).toBe("me/x");
  expect(parseRepo("https://github.com/me/x")).toBe("me/x");
  expect(parseRepo("ssh://git@github.com/me/x.git")).toBe("me/x");
  expect(parseRepo("git@gitlab.com:me/x.git")).toBeNull();
});
