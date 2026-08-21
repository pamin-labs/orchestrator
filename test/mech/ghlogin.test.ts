import { expect, test } from "bun:test";
import { desc, count as countRows } from "drizzle-orm";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { project as projectTable } from "../../src/platform/persistence/schema.ts";
import { listAuth, loadAuth, saveAuth, vaultFor } from "../../src/mech/sandbox/auth.ts";
import { makeGithub, type Github } from "../../src/mech/git/github.ts";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import * as fx from "../support/factories.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { testContext } from "../support/test-context.ts";
import { z } from "zod";
import type { Json } from "../../src/contracts/json.ts";
import {
  BOT,
  commitIdentity,
  forgetIdentity,
  CLIENT_ID,
  githubAccount,
  listInstallations,
  listRepos,
  pollForToken,
  startDeviceFlow,
  type DeviceFlowFetcher,
} from "../../src/mech/git/ghlogin.ts";

/** A fetcher that answers from a script and records what it was sent. */
function scripted(answers: Json[]): { fetchFn: DeviceFlowFetcher; sent: Array<{ url: string; body: string }> } {
  const sent: Array<{ url: string; body: string }> = [];
  let i = 0;
  const fetchFn: DeviceFlowFetcher = async (url, init) => {
    sent.push({ url, body: init?.body ?? "" });
    const a = answers[Math.min(i++, answers.length - 1)];
    const status = a && typeof a === "object" && "status" in a && typeof a.status === "number" ? a.status : 200;
    return { ok: status < 400, status, json: async () => a };
  };
  return { fetchFn, sent };
}

const DEVICE = {
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  deviceCode: "dev-code",
  interval: 5,
  expiresIn: 900,
};

const GithubReposResponse = z.object({
  installations: z.array(z.looseObject({ id: z.number() })),
  selected: z.number().nullable(),
  installUrl: z.string(),
  repos: z.array(
    z.object({
      fullName: z.string(),
      taken: z.object({ id: z.number(), name: z.string() }).nullable(),
    }),
  ),
});
const GithubAuthResponse = z.object({
  accounts: z.array(z.object({ id: z.number(), account: z.string(), kind: z.string(), repos: z.number() })),
  installUrl: z.string(),
  app: z.never().optional(),
});
const ProjectResponse = z.object({ id: z.number() });

const jsonBody = (body: Json): Json => body;

test("the device flow asks for a code, with no secret and no scope", async () => {
  // No secret: that is the whole reason this flow is shippable in an open repo,
  // and why the client id can live in committed yaml. No scope either: a GitHub
  // App has none — what the token may do is declared on the app and chosen when
  // it is installed.
  const { fetchFn, sent } = scripted([
    {
      device_code: "dev-code",
      user_code: "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      interval: 5,
      expires_in: 900,
    },
  ]);
  const d = await startDeviceFlow(fetchFn);
  expect(d.userCode).toBe("WDJB-MJHT");
  expect(d.deviceCode).toBe("dev-code");
  expect(sent[0]!.url).toBe("https://github.com/login/device/code");
  expect(sent[0]!.body).toBe(`client_id=${CLIENT_ID}`);
  expect(sent[0]!.body).not.toContain("scope");
  expect(sent[0]!.body).not.toContain("secret");
});

test("a JSON response still has to be a device-flow response", async () => {
  // oxlint-disable-next-line typescript/await-thenable -- Bun's async matcher is awaitable, but Matchers is not declared Thenable
  await expect(startDeviceFlow(scripted([null]).fetchFn)).rejects.toThrow("invalid device-flow response");
});

test("authorization_pending keeps polling, and the exchange carries the device grant", async () => {
  const { fetchFn, sent } = scripted([
    { error: "authorization_pending" },
    { error: "authorization_pending" },
    { access_token: "gho_real" },
  ]);
  const waits: number[] = [];
  const token = await pollForToken(DEVICE, {
    fetchFn,
    sleep: async (ms) => void waits.push(ms),
  });
  expect(token).toBe("gho_real");
  expect(sent).toHaveLength(3);
  expect(waits).toEqual([5000, 5000, 5000]);
  expect(sent[0]!.url).toBe("https://github.com/login/oauth/access_token");
  expect(sent[0]!.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
  expect(sent[0]!.body).toContain("device_code=dev-code");
  expect(sent[0]!.body).not.toContain("secret");
});

test("slow_down widens the interval, which is the whole reason to handle it", async () => {
  // Polling faster than GitHub allows gets the flow rate-limited into an
  // expired code — the failure a hand-rolled loop forgets. GitHub says what the
  // new interval is; its documented floor is +5s when it does not.
  const { fetchFn } = scripted([
    { error: "slow_down", interval: 10 },
    { error: "slow_down" },
    { access_token: "gho_real" },
  ]);
  const waits: number[] = [];
  const token = await pollForToken(DEVICE, {
    fetchFn,
    sleep: async (ms) => void waits.push(ms),
  });
  expect(token).toBe("gho_real");
  expect(waits).toEqual([5000, 10_000, 15_000]);
});

test("a refused or expired login stops, and says which", async () => {
  const denied = scripted([{ error: "access_denied" }]);
  // oxlint-disable-next-line typescript/await-thenable -- Bun's async matcher is awaitable, but Matchers is not declared Thenable
  await expect(pollForToken(DEVICE, { fetchFn: denied.fetchFn, sleep: async () => {} })).rejects.toThrow(
    /denied on GitHub/,
  );

  const expired = scripted([{ error: "expired_token" }]);
  // oxlint-disable-next-line typescript/await-thenable -- Bun's async matcher is awaitable, but Matchers is not declared Thenable
  await expect(pollForToken(DEVICE, { fetchFn: expired.fetchFn, sleep: async () => {} })).rejects.toThrow(
    /device code expired/,
  );

  // And a code that runs out while nobody is looking is the same message rather
  // than a poll that never returns.
  const forever = scripted([{ error: "authorization_pending" }]);
  let clock = 0;
  // oxlint-disable-next-line typescript/await-thenable -- Bun's async matcher is awaitable, but Matchers is not declared Thenable
  await expect(
    pollForToken(DEVICE, {
      fetchFn: forever.fetchFn,
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
    }),
  ).rejects.toThrow(/device code expired/);
});

test("the token lands in runtime_auth like every other credential", async () => {
  // Stored, not returned: the panel reads a masked tail, and the value itself
  // only ever leaves this process into the egress sidecar's vault.
  const db = await openMemory();
  const { fetchFn } = scripted([{ access_token: "gho_real_token_abc123" }]);
  const token = await pollForToken(DEVICE, { fetchFn, sleep: async () => {} });
  await saveAuth(db, { runtime: "github", mode: "api_key", secret: token });

  expect((await loadAuth(db, "github"))!.secret).toBe("gho_real_token_abc123");
  const shown = (await listAuth(db)).find((r) => r.runtime === "github")!;
  expect(shown.hint).toBe("…abc123");
  expect(JSON.stringify(shown)).not.toContain("gho_real_token_abc123");

  // git speaks Basic, and the sidecar is what holds the real value.
  const bound = (await vaultFor(db)).credentials.find((c) => c.name === "github")!;
  expect(bound.value).toBe(`Basic ${btoa(`x-access-token:gho_real_token_abc123`)}`);
  expect(bound.hosts).toContain("github.com");
});

/**
 * A GitHub client whose answers are a table, and a log of what it asked.
 *
 * Everything past the login goes through `mech/github.ts`, so this is what a
 * test injects — the same seam `prwatch` uses.
 */
async function client(answer: (url: string) => Json): Promise<{ gh: Github; asked: string[]; db: DB }> {
  const db = await openMemory();
  await saveAuth(db, { runtime: "github", mode: "api_key", secret: "gho_x" });
  const asked: string[] = [];
  const gh = makeGithub(db, async (url) => {
    asked.push(url);
    return new Response(JSON.stringify(answer(url)), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { gh, asked, db };
}

const repo = (n: number) => ({
  full_name: `acme/r${n}`,
  private: n % 2 === 0,
  default_branch: "trunk",
  pushed_at: "2026-08-01T00:00:00Z",
  clone_url: `https://github.com/acme/r${n}.git`,
});

test("repositories come from the installation, never /user/repos", async () => {
  // /user/repos is the OAuth App answer: it lists what the *user* can see,
  // including repositories this app was never installed on. A project made from
  // one of those fails at its first clone with a 404 that cannot say why.
  const { gh, asked } = await client(() => ({ total_count: 1, repositories: [repo(1)] }));
  const r = await listRepos(gh, 77);
  expect(r.ok && r.data).toEqual([
    {
      fullName: "acme/r1",
      private: false,
      defaultBranch: "trunk",
      pushedAt: Date.parse("2026-08-01T00:00:00Z"),
      cloneUrl: "https://github.com/acme/r1.git",
    },
  ]);
  expect(asked[0]).toContain("/user/installations/77/repositories");
  expect(asked.join(" ")).not.toContain("/user/repos");
});

test("GitHub's legal nulls do not discard an installation or an empty repository", async () => {
  const { gh } = await client((url) =>
    jsonBody(
      url.includes("/repositories")
        ? { repositories: [{ ...repo(1), pushed_at: null }] }
        : { installations: [{ id: 5, account: null }] },
    ),
  );

  const installs = await listInstallations(gh);
  expect(installs.ok && installs.data).toEqual([{ id: 5, account: "?", kind: "User" }]);
  const repos = await listRepos(gh, 5);
  expect(repos.ok && repos.data[0]?.pushedAt).toBe(0);
});

test("a boss in several orgs gets past page one", async () => {
  // Both endpoints paginate at 100. Stopping at the first page is the bug that
  // looks like "that repo is not on GitHub".
  const full = Array.from({ length: 100 }, (_, i) => repo(i));
  const { gh, asked } = await client((url) => ({
    repositories: url.endsWith("page=1") ? full : [repo(999)],
  }));
  const r = await listRepos(gh, 1);
  expect(r.ok && r.data.length).toBe(101);
  expect(asked).toHaveLength(2);
  expect(asked[1]).toContain("page=2");
});

test("installations are the org switcher, and an empty list is not an error", async () => {
  const { gh, asked } = await client(() => ({
    total_count: 2,
    installations: [
      { id: 5, account: { login: "octocat", type: "User" } },
      { id: 9, account: { login: "acme", type: "Organization" } },
    ],
  }));
  const r = await listInstallations(gh);
  expect(r.ok && r.data).toEqual([
    { id: 5, account: "octocat", kind: "User" },
    { id: 9, account: "acme", kind: "Organization" },
  ]);
  expect(asked[0]).toContain("/user/installations?");

  // Authorized with nothing installed: a real answer, not a failure. The panel
  // turns it into "install it somewhere" rather than an empty box.
  const empty = await client(() => ({ total_count: 0, installations: [] }));
  const none = await listInstallations(empty.gh);
  expect(none.ok && none.data).toEqual([]);
});

test("the account is asked of GitHub, and a dead token reads as no account", async () => {
  const { gh } = await client(() => ({ login: "octocat" }));
  expect(await githubAccount(gh)).toBe("octocat");

  // 404 as well as 401: GitHub answers 404 for what a token cannot see, so this
  // deliberately does not try to say which of the two it was.
  const db = await openMemory();
  await saveAuth(db, { runtime: "github", mode: "api_key", secret: "gho_x" });
  expect(await githubAccount(makeGithub(db, async () => new Response("{}", { status: 404 })))).toBeNull();
  expect(
    await githubAccount(
      makeGithub(db, async () => {
        throw new Error("offline");
      }),
    ),
  ).toBeNull();
});

/** Enough Ctx for the two routes, with GitHub answered from a table. */
async function server(answer: (url: string) => Json) {
  const db = await openMemory();
  await seedAuth(db);
  await saveAuth(db, { runtime: "github", mode: "api_key", secret: "gho_x" });
  const bus = new Bus(db);
  const sched = new Scheduler(db, async () => {});
  const asked: string[] = [];
  const ctx: Ctx = {
    db,
    bus,
    sched,
    waiters: new Map(),
    gh: makeGithub(db, async (url) => {
      asked.push(url);
      return new Response(JSON.stringify(answer(url)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    config: loadConfig(),
  };
  return { db, ctx, app: makeApp(ctx), asked };
}

const get = (app: (r: Request) => Promise<Response>, path: string) => app(new Request(`http://x${path}`));

test("a login with no installations lists nothing and says where to fix it", async () => {
  // The empty box is the failure: authorized, green, and no repository will ever
  // appear. The answer carries the install link instead.
  const { app } = await server(() => ({ total_count: 0, installations: [] }));
  const r = await get(app, "/api/v1/github/repos");
  expect(r.status).toBe(200);
  const b = GithubReposResponse.parse(await r.json());
  expect(b.installations).toEqual([]);
  expect(b.repos).toEqual([]);
  expect(b.selected).toBeNull();
  expect(b.installUrl).toBe("https://github.com/apps/orchestrator-agentic-app/installations/new");
});

test("switching installation changes the list", async () => {
  const { app, asked } = await server((url) =>
    jsonBody(
      url.includes("/user/installations?")
        ? {
            installations: [
              { id: 5, account: { login: "octocat", type: "User" } },
              { id: 9, account: { login: "acme", type: "Organization" } },
            ],
          }
        : {
            repositories: [
              { full_name: url.includes("/9/") ? "acme/site" : "octocat/dotfiles", default_branch: "main" },
            ],
          },
    ),
  );

  // No installation asked for: the first one, so the page has something to show.
  const first = GithubReposResponse.parse(await (await get(app, "/api/v1/github/repos")).json());
  expect(first.selected).toBe(5);
  expect(first.repos.map((repo) => repo.fullName)).toEqual(["octocat/dotfiles"]);

  // Picking the org is not a second login — same token, another installation.
  const org = GithubReposResponse.parse(await (await get(app, "/api/v1/github/repos?installation=9")).json());
  expect(org.selected).toBe(9);
  expect(org.repos.map((repo) => repo.fullName)).toEqual(["acme/site"]);
  expect(asked.join("\n")).toContain("/user/installations/9/repositories");
});

test("a project added from the list keeps GitHub's default branch, not a guess", async () => {
  const { app, db } = await server(() => ({
    full_name: "acme/site",
    default_branch: "trunk",
    clone_url: "https://github.com/acme/site.git",
  }));
  const r = await app(
    new Request("http://x/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ repo: "acme/site" }),
    }),
  );
  expect(r.status).toBe(200);
  // The id is the whole reason the browser can land on what it just made. It was
  // being returned and thrown away, so adding a project put the boss back on the
  // screen they started from with nothing selected.
  expect(ProjectResponse.parse(await r.json()).id).toBeGreaterThan(0);
  const [row] = await db
    .select({
      name: projectTable.name,
      repo_path: projectTable.repo_path,
      remote: projectTable.remote,
      base_branch: projectTable.base_branch,
    })
    .from(projectTable)
    .orderBy(desc(projectTable.id))
    .limit(1);
  expect(row!.base_branch).toBe("trunk");
  expect(row!.remote).toBe("https://github.com/acme/site.git");
  // Seam (007 step 6): identity is still repo_path, holding `owner/name`.
  expect(row!.repo_path).toBe("acme/site");
  expect(row!.name).toBe("site");

  // Adding it twice is the same project, whichever way it was picked.
  const again = await app(
    new Request("http://x/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ repo: "acme/site" }),
    }),
  );
  expect(again.status).toBe(422);
});

test("a shape-invalid repository reply is a 422, never a route 500", async () => {
  const { app, db } = await server(() => ({ full_name: "acme/site", default_branch: "main" }));
  const r = await app(
    new Request("http://x/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ repo: "acme/site" }),
    }),
  );

  expect(r.status).toBe(422);
  expect(await r.text()).toContain("GitHub sent invalid JSON");
  expect((await db.select({ n: countRows() }).from(projectTable))[0]!.n).toBe(0);
});

test("a repository already added names its project, so the row is a route and not a wall", async () => {
  // `taken: true` told the boss the repository they came for is unreachable and
  // stopped there. Which project it became is the way out, and the row already
  // has to be rendered either way.
  const { app, db } = await server((url) =>
    jsonBody(
      url.includes("/user/installations?")
        ? { installations: [{ id: 5, account: { login: "acme", type: "Organization" } }] }
        : {
            repositories: [
              { full_name: "acme/site", default_branch: "main" },
              { full_name: "acme/other", default_branch: "main" },
            ],
          },
    ),
  );
  await fx.on(db).project.create({ name: "工地", repo_path: "acme/site" });

  const b = GithubReposResponse.parse(await (await get(app, "/api/v1/github/repos")).json());
  const by = Object.fromEntries(b.repos.map((repo) => [repo.fullName, repo.taken]));
  const site = by["acme/site"];
  if (!site) throw new Error("registered repository was not marked as taken");
  expect(site.name).toBe("工地");
  expect(site.id).toBeGreaterThan(0);
  // Null rather than `false`: there is no project to send anyone to.
  expect(by["acme/other"]).toBeNull();
});

test("the status carries which accounts it is installed on, and how much each can see", async () => {
  // The app itself is not configurable from the panel: everyone goes through
  // one app, and a box that drops the stored login when touched served nobody.
  // What the page does need is the half the boss asked for — which accounts the
  // app is installed on, and how many repositories each one can see.
  const { app } = await server((url) =>
    jsonBody(
      url.includes("/user/installations/")
        ? { total_count: 3 }
        : url.includes("/user/installations")
          ? { installations: [{ id: 5, account: { login: "acme", type: "Organization" } }] }
          : { login: "octocat" },
    ),
  );

  const b = GithubAuthResponse.parse(await (await get(app, "/api/v1/auth/github")).json());
  expect(b.accounts).toEqual([{ id: 5, account: "acme", kind: "Organization", repos: 3 }]);
  // The install link comes from the yaml's `appSlug`, which is now its only source.
  expect(b.installUrl).toBe("https://github.com/apps/orchestrator-agentic-app/installations/new");
  expect(b.app).toBeUndefined();

  // And the route that wrote the override is gone with the panel section.
  const gone = await app(
    new Request("http://x/api/v1/auth/github/app", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ clientId: "x" }),
    }),
  );
  expect(gone.status).toBe(404);
});

test("the list comes back most recently pushed first", async () => {
  // GitHub returns them in its own order — read down the screenshot that
  // prompted this, 76 months, 51, 4, 61, 72, 71, 14 — and the repository the
  // boss wants is almost always the one they touched last. Sorted at the source
  // so the picker and anything else added later get it for free.
  const { gh } = await client(() =>
    jsonBody({
      repositories: [
        { full_name: "a/old", pushed_at: "2020-01-01T00:00:00Z" },
        { full_name: "a/new", pushed_at: "2026-08-01T00:00:00Z" },
        { full_name: "a/mid", pushed_at: "2024-05-01T00:00:00Z" },
        { full_name: "a/never" },
      ],
    }),
  );
  const r = await listRepos(gh, 1);
  expect(r.ok && r.data.map((x) => x.fullName)).toEqual(["a/new", "a/mid", "a/old", "a/never"]);
});

test("naming the installation costs one round trip, not two", async () => {
  // The route cannot ask for repositories until it knows the id, so a cold open
  // is two trips in series — 260-630ms each, measured. When the caller names one
  // (every open after the first, the panel remembers it) both halves go at once.
  const { app, asked } = await server((url) =>
    jsonBody(
      url.includes("/user/installations/")
        ? { repositories: [{ full_name: "acme/site" }] }
        : { installations: [{ id: 9, account: { login: "acme", type: "Organization" } }] },
    ),
  );
  const b = GithubReposResponse.parse(await (await get(app, "/api/v1/github/repos?installation=9")).json());
  expect(b.selected).toBe(9);
  expect(b.repos.map((repo) => repo.fullName)).toEqual(["acme/site"]);
  // Both were asked for, and neither waited on the other.
  expect(asked.join("\n")).toContain("/user/installations?");
  expect(asked.join("\n")).toContain("/user/installations/9/repositories");
  // And the repositories were fetched once, not once per guess.
  expect(asked.filter((u) => u.includes("/repositories")).length).toBe(1);
});

test("commits are authored by the connected account, so a DCO sign-off means something", async () => {
  // The identity used to be a literal, `orch agent <agent@orch.local>`. That is
  // fine until a repository enforces DCO: the `Signed-off-by` line has to match
  // the author, and a made-up address is not an identity anyone can be said to
  // have signed as. The account that authorised this orchestrator is one.
  const db = await openMemory();
  await saveAuth(db, { runtime: "github", mode: "api_key", secret: "gho_x" });
  const ctx = await testContext({
    db,
    gh: makeGithub(
      db,
      async () =>
        new Response(JSON.stringify({ login: "octo", id: 583231, name: "The Octocat" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  });

  const who = await commitIdentity(ctx);
  // GitHub's own noreply form, and the `id+` prefix is required — the bare
  // `login@users.noreply.github.com` is the legacy one and no longer routes.
  expect(who).toEqual({ name: "The Octocat", email: "583231+octo@users.noreply.github.com" });

  // Cached, because this runs on every checkout and the answer only changes when
  // the account does.
  const dead = await testContext({ db, gh: makeGithub(db, async () => new Response("{}", { status: 401 })) });
  expect(await commitIdentity(dead)).toEqual(who);
  await forgetIdentity(dead);
  // And with nothing connected a checkout still has to work — as the App's own
  // bot, which is a real account on github.com, not the invented
  // `orch agent <agent@orch.local>` whose address routed nowhere and whose name
  // belonged to nobody. A sign-off carrying that certified nothing.
  expect(await commitIdentity(dead)).toEqual(BOT);
});

test("an undocumented device-flow error is reported, not polled until the code expires", async () => {
  // The switch handled four errors and had no default, so GitHub's documented
  // `incorrect_client_credentials`, `unsupported_grant_type` and
  // `device_flow_disabled` fell through to the loop. The dialog then span for the
  // full `expiresIn` and reported "the code expired" — the wrong cause, quarter of
  // an hour late.
  const { fetchFn } = scripted([{ error: "device_flow_disabled", error_description: "Device flow is not enabled" }]);
  // A clock that advances, so the pre-fix behaviour terminates instead of hanging.
  let t = 0;
  const now = () => {
    t += 60_000;
    return t;
  };
  const failed = await pollForToken(DEVICE, { fetchFn, sleep: async () => {}, now }).catch((e: unknown) => e);
  expect(String(failed)).toContain("Device flow is not enabled");
});
