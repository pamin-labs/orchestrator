import { msg } from "@lingui/core/macro";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../../mech/ctx.ts";
import { readSetting, writeSetting } from "../../platform/persistence/database.ts";
import { jsonOr } from "../../contracts/json.ts";
import { release } from "../../mech/flow/intercept.ts";
import { escalationKey } from "../../mech/flow/escalate.ts";
import {
  APP_SLUG,
  BOT,
  commitIdentity,
  type DeviceCode,
  type DeviceFlowFetcher,
  forgetIdentity,
  githubAccount,
  type Installation,
  listInstallations,
  listRepos,
  pollForToken,
  setTrailers,
  startDeviceFlow,
  trailers,
} from "../../mech/git/ghlogin.ts";
import {
  AuthRuntimeSchema,
  listAuth,
  loadAuth,
  type RuntimeAuth,
  RuntimeAuthSchema,
  SANDBOX_KEY,
  saveAuth,
  wrongShape,
} from "../../mech/sandbox/auth.ts";
import {
  DEVICE_CODE_TTL_MS,
  type LoginRun,
  currentClaudeLogin,
  currentCodexDeviceLogin,
  PASTE_TTL_MS,
  startClaudeLogin,
  startCodexDeviceLogin,
} from "../../mech/sandbox/login.ts";
import { killSandbox, serverKeyOnDisk, storeServerKey } from "../../mech/sandbox/sandbox.ts";
import { inspectServer } from "../../mech/sandbox/server.ts";
import type { Said } from "../../contracts/said.ts";
import { errText } from "../../platform/process/text.ts";
import type { ClaudeLoginFlow, CodexLoginFlow } from "../../contracts/login-flow.ts";
import type { Handler } from "../../http/handler.ts";
import { bad, badText, json, message } from "../../http/respond.ts";

import { escalation, grp, project, runtime_auth } from "../../platform/persistence/schema.ts";

/**
 * Signing in: to the two model accounts, to GitHub, and to the sandbox server.
 *
 * Each flow keeps one module-level slot, so a login nobody finished must not
 * hold it forever — which is what the expiry and the cancel routes are for.
 */

/**
 * Which runtime is configured, and how. Never the secret: the value leaves this
 * process only into an egress sidecar's vault, so the page that sets it reads
 * back a masked tail.
 */
// `trailers` rides along: the Claude block draws one of the three switches, and
// a second fetch for one boolean is a second thing that can be stale.
/**
 * The install has no GitHub client, said the same way in all three places.
 *
 * It was three: two spellings of "this server has no GitHub client" and one
 * with the words the other way round. Nothing chose between them and nothing
 * would have noticed a fourth. English, and no id with it — this is a broken
 * wiring rather than a value the boss can correct, which ADR 035 leaves in the
 * English column.
 */
export const noGithubClient = () => bad(msg`this server has no GitHub client`);

export const getAuth = (async (ctx) =>
  json({ runtimes: await listAuth(ctx.db), trailers: await trailers(ctx.db) })) satisfies Handler;

/**
 * `secret` is not length-capped and not logged. A pasted `auth.json` is tens of
 * kilobytes and a token is a hundred bytes, so a cap would refuse a real
 * credential. `wrongShape` judges it, by shape.
 */
export const AuthBody = z.union([
  z.strictObject({ runtime: AuthRuntimeSchema, clear: z.literal(true) }),
  z.strictObject({ runtime: z.literal(SANDBOX_KEY), mode: z.literal("api_key"), adopt: z.literal(true) }),
  RuntimeAuthSchema,
]);

export const postAuth = (async (ctx, _req, _p, b) => {
  // Something wrong got stored — a login URL pasted into the token box, an old
  // account. Removing it is the only way back to "not configured", which is a
  // state the scheduler and the panel both understand.
  if ("clear" in b) {
    await ctx.db.delete(runtime_auth).where(eq(runtime_auth.runtime, b.runtime));
    for (const g of await ctx.db.select({ id: grp.id }).from(grp).where(isNotNull(grp.sandbox_id))) {
      await killSandbox(ctx, { grp: g.id });
    }
    return message("ok");
  }

  // Returns here rather than joining the path below through a shared variable:
  // a secret read off disk must not be able to reach the probe at all, and a
  // guard further down would still let both branches meet in one binding.
  //
  // Nothing is sent. A key read out of the server's own config **is** the key
  // that server is running with. It is stored bound to the address in that same
  // file, so no later change to `sandbox.server` can send it elsewhere.
  if ("adopt" in b) {
    const found = serverKeyOnDisk();
    if (!found)
      return bad(
        msg`No sandbox server config found. It was started with --config, so put that file's path in OPENSANDBOX_CONFIG, or move the file to ./sandbox.toml or ~/.sandbox.toml.`,
      );
    // Overwrites whatever is stored, unlike the boot-time `adoptServerKey`: this
    // is the button somebody presses *because* the stored key is the wrong one.
    await storeServerKey(ctx.db, found);
    await credentialChanged(ctx, SANDBOX_KEY);
    return message("ok");
  }

  // Only ever the request body from here down.
  let auth: RuntimeAuth = b;

  // The sandbox key is ours, not a provider's, so it has no shape to check.
  if (auth.runtime !== SANDBOX_KEY) {
    const wrong = wrongShape(auth);
    if (wrong) return badText(wrong);
  }
  // The one credential whose owner we can ask, and the one where a wrong value
  // is silent and total: it overrides the environment, so a key the server does
  // not share 401s every turn, gate and diff. Refused rather than stored.
  if (auth.runtime === SANDBOX_KEY) {
    const server = ctx.config.sandbox?.server ?? "127.0.0.1:8080";
    const verdict = await sandboxKeyWorks(server, auth.secret);
    if (verdict === "invalid")
      return bad(msg`The sandbox server rejects this key. Enter the one written in that server's own config.`);
    // Stored with the address it was just accepted by, so moving the address
    // later cannot make this key follow it. `sandboxKeyFor` is the reader.
    auth = { ...auth, baseUrl: `http://${server}` };
  }
  await saveAuth(ctx.db, auth);
  await credentialChanged(ctx, auth.runtime);
  return message("ok");
}) satisfies Handler<z.infer<typeof AuthBody>>;

/**
 * Ask the sandbox server whether it would accept this key.
 *
 * `unknown` when it cannot be reached: a server that is down is a preflight
 * finding, not a reason to refuse a key that may well be right.
 */
async function sandboxKeyWorks(server: string, key: string): Promise<"ok" | "invalid" | "unknown"> {
  try {
    // Built rather than interpolated. `server` is `host[:port]` by contract
    // (`config.ts` rejects anything else), and `new URL` is what makes that
    // guarantee load-bearing: a path or a query in the value would replace this
    // path rather than extend the host, which is how a probe carrying the
    // sandbox key ends up somewhere else.
    // fallow-ignore-next-line security-sink -- the destination is `cfg.sandbox.server`, which `contracts/config.ts` now constrains to `host` or `host:port` — no scheme, path, query or credentials — so the value can only choose the address, which is the feature. `new URL` is what makes that constraint load-bearing rather than advisory. The key sent with it is the key stored for that same address, the panel is loopback-only, and no request field reaches here.
    const r = await fetch(new URL("/v1/sandboxes", `http://${server}`), {
      headers: { "OPEN-SANDBOX-API-KEY": key },
      signal: AbortSignal.timeout(3000),
    });
    return r.ok ? "ok" : r.status === 401 ? "invalid" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * What has to happen after a credential is stored, wherever it was stored.
 *
 * Existing sandboxes hold the old value in their sidecars, so they are killed
 * and the next turn binds the new credential. Shared rather than inline because
 * every way in has to do it, not just the one that happens to be edited.
 */
export async function credentialChanged(ctx: Ctx, runtime: string): Promise<void> {
  for (const g of await ctx.db.select({ id: grp.id }).from(grp).where(isNotNull(grp.sandbox_id))) {
    await killSandbox(ctx, { grp: g.id });
  }
  // The other end of this matcher is `executor.ts`, which files the question
  // under the same key. It was a prefix test over the Chinese first line of the
  // question, spelled in raw SQL because `substr`/`length` have no builder and
  // `like` would read the `%` and `_` in a runtime name as wildcards. A key is
  // an ordinary `=`, and translating the sentence no longer reaches it.
  await ctx.db
    .update(escalation)
    .set({
      chain_state: "answered",
      answered_by: "boss",
      answer: "reconfigured",
      answered_at: Date.now(),
    })
    // `isNull`, not `eq(..., null)`: `= NULL` is NULL, which matches nothing.
    .where(and(isNull(escalation.answer), eq(escalation.dedupe_key, escalationKey.auth(runtime))));
  // Only the groups this credential stopped. Unscoped, this matches every PAUSED
  // row there is — a hand-paused group, a budget-burnt one, a rate-limited one
  // still carrying `rl_resets_at` that watchdog rule 6 then never clears.
  await release(ctx, null, { only: `auth:${runtime}` });
  // A different account commits under a different name, and a stale one would
  // sign off as somebody who is no longer connected.
  if (runtime === "github") {
    await forgetIdentity(ctx);
    await forgetGithubConnection(ctx);
  }
  await ctx.sched.tick();
  // And say so. The host checks are what the shell's banner draws and they are
  // refreshed on the readiness timer, so signing in left the banner reporting
  // `credential:claude` unconfigured above a settings row that already said the
  // token was stored — until the next tick got round to disagreeing with it.
  // `ctx.recheck` runs them and republishes, which is what the settings page
  // already does after a save. Awaited, so the panel's next read is behind the
  // new verdict rather than racing it.
  await ctx.recheck?.();
}

/**
 * Sign in to a Claude account, from the utility container.
 *
 * The CLI is `claude setup-token` itself, under a pty, in the container. Nothing
 * here builds a URL or calls a token endpoint — see `startClaudeLogin`.
 *
 * No completion route: `run.done` writes `runtime_auth` itself, so the
 * credential row the panel already polls **is** the confirmation.
 */
let claudeFlow: ClaudeLoginFlow | null = null;

/**
 * The continuation the login route deliberately does not wait for — kept, so that
 * something can.
 *
 * `postClaudeLogin` answers with the link the moment the CLI prints it, while the
 * run still owes a `saveAuth`. Written `void run.done.then(…)` that promise was
 * unreachable: the credential landed whenever it landed, and the one route whose
 * whole job is "this flow is over" returned ok with the write still in flight.
 */
/**
 * Bounded by `execLines`'s own `timeoutMs` and by the abort `cancel` fires, so
 * this adds no second timer beside them. Rejections are swallowed here on
 * purpose: a login that failed is still a login that ended, and the reason
 * already reached the bus from inside the continuation.
 */
let claudeSettled: Promise<unknown> = Promise.resolve();

/**
 * Wait for the CLI to print what the boss has to see, or for the run to end.
 *
 * The run's own exit ends the wait as well: a CLI that printed nothing and quit
 * is already an answer, and waiting out the window for it is a spinner over a
 * process that is gone.
 */
async function printed<T>(run: LoginRun, read: () => T | null | undefined, tries: number): Promise<T | null> {
  const ended = run.done.then(
    () => true,
    () => true,
  );
  const tick = () => Promise.race([ended, Bun.sleep(100).then(() => false)]);
  for (let i = 0; i < tries && !read(); i++) if (await tick()) break;
  return read() ?? null;
}

/**
 * Why a login printed nothing, when the reason is one layer down.
 *
 * Both CLIs run through `execLines(ctx, UTIL, …)`, so a sandbox server that
 * refuses us is a login that prints nothing — indistinguishable, from up here,
 * from a CLI whose output we no longer recognise. It was reported as the second:
 * the boss sent into the image to find out why, while the panel's own timeline
 * already said the sandbox server was refusing us.
 */
/**
 * Only on the failure path, so a successful login pays nothing for it, and
 * `probe` inside `inspectServer` carries its own 1.5s timeout.
 */
async function sandboxFault(ctx: Ctx): Promise<Said | null> {
  const state = await inspectServer(ctx);
  // `stuck` only, deliberately. That is the diagnosable one: something answers
  // the address and refuses us, so no container is ever going to start and the
  // reason is already known. `down` is not added to it — a server that is merely
  // not running is what `startPlan` exists to fix and what preflight already
  // reports, and treating it as this fault would replace the CLI's own advice
  // everywhere a server has not been started yet, which is most first runs.
  return state.kind === "stuck" ? state.why : null;
}

export const postClaudeLogin = (async (ctx) => {
  if (claudeFlow && claudeFlow.expiresAt > Date.now()) return json(claudeFlow);
  const run = startClaudeLogin(ctx);
  const startedAt = Date.now();
  const url = await printed(run, () => run.url, 150);
  if (!url) {
    run.cancel();
    // The sandbox verdict is returned as it stands rather than wrapped in a
    // sentence of ours: a descriptor inside another's values is one sentence in
    // two languages, which `values-carry-no-rendered-text` exists to stop. It
    // already reads as the reason, and it is shown beside the button that failed.
    const fault = await sandboxFault(ctx);
    if (fault) return bad(fault);
    return bad(
      msg`claude printed no login link inside the container — the login already gives it a terminal, so run \`claude setup-token\` in the image to see what it prints instead.`,
    );
  }
  claudeFlow = { url, expiresAt: startedAt + PASTE_TTL_MS };
  claudeSettled = run.done.then(async (r) => {
    claudeFlow = null;
    if (r.ok) await credentialChanged(ctx, "claude");
    await ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      say: r.ok ? msg`claude is signed in` : msg`claude could not sign in: ${{ detail: r.detail }}`,
    });
  });
  return json(claudeFlow);
}) satisfies Handler;

/** The code off that page, handed to the prompt the CLI is sitting at. */
export const CodeBody = z.object({ code: z.string().max(4000).default("") });

export const postClaudeCode = (async (ctx, _req, _p, b) => {
  const code = b.code.trim();
  if (!code) return bad(msg`no code given`);
  const run = currentClaudeLogin();
  if (!claudeFlow || !run) return bad(msg`no login is waiting for a code — start one first`);
  await run.submit(code);
  return message("ok");
}) satisfies Handler<z.infer<typeof CodeBody>>;

/**
 * How long a cancel waits for the run it just aborted to finish saying so.
 *
 * Bounded, because the wait is a courtesy and the cancel is not. `await` on it
 * alone hung the route for as long as the exec ignored its abort — which is
 * exactly the state somebody presses cancel in.
 */
const SETTLE_GRACE_MS = 2_000;

export const postClaudeCancel = (async (_ctx) => {
  currentClaudeLogin()?.cancel();
  claudeFlow = null;
  // Raced, not awaited. `claudeSettled` is here so a test can see the bus event
  // the continuation emits; it is not a reason to hold an HTTP request open
  // behind a container exec that has stopped answering.
  await Promise.race([claudeSettled.catch(() => {}), Bun.sleep(SETTLE_GRACE_MS)]);
  return message("ok");
}) satisfies Handler;

/**
 * Connect GitHub, device flow, no token pasted and no `gh` on this machine.
 *
 * The poll runs here rather than in the browser: it holds the device code, which
 * is the half that trades for a token, and it has to finish even if the settings
 * dialog is closed halfway through.
 */
interface GhFlow {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}
let ghFlow: GhFlow | null = null;
/** Why the last attempt did not land. Shown next to the button that retries it. */
let ghError: string | null = null;

/** The code the boss is still meant to be typing, if it has not expired. */
function livePending(): GhFlow | null {
  return ghFlow && ghFlow.expiresAt > Date.now() ? ghFlow : null;
}

/**
 * Wait out the browser half, then store what it produced.
 *
 * Awaited by nothing in production: the poll outlives the request that started
 * it. The device code never leaves here — the panel is told the outcome, and a
 * failure carries GitHub's reason, not the exchange.
 */
export async function finishGithubLogin(ctx: Ctx, d: DeviceCode, fetchFn?: DeviceFlowFetcher): Promise<void> {
  try {
    const token = await pollForToken(d, fetchFn ? { fetchFn } : {});
    await saveAuth(ctx.db, { runtime: "github", mode: "api_key", secret: token });
    // Every running sandbox holds the old (absent) credential in its sidecar.
    await credentialChanged(ctx, "github");
    await ctx.bus.emit({ author: "orchestrator", kind: "state_change", say: msg`GitHub is connected` });
  } catch (e) {
    ghError = errText(e);
    await ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      say: msg`GitHub is not connected: ${{ why: ghError }}`,
    });
  } finally {
    ghFlow = null;
  }
}

/** `fetchFn` is how a test scripts GitHub's two endpoints; production has one. */
export async function githubDeviceLogin(ctx: Ctx, fetchFn?: DeviceFlowFetcher): Promise<Response> {
  // A second click while one code is still good hands back the same code rather
  // than starting a second poll: two loops racing for one login is two ways to
  // store a token and one of them wins silently.
  const live = livePending();
  if (live) {
    return json({
      userCode: live.userCode,
      verificationUri: live.verificationUri,
      expiresIn: Math.round((live.expiresAt - Date.now()) / 1000),
    });
  }
  let d: DeviceCode;
  try {
    d = await startDeviceFlow(fetchFn);
  } catch (e) {
    // `errText`, not `e?.message`: a thrown non-Error has no `message`, and the
    // object itself reaches the response body as "[object Object]".
    return badText(errText(e) || "GitHub returned no device code");
  }
  ghFlow = { userCode: d.userCode, verificationUri: d.verificationUri, expiresAt: Date.now() + d.expiresIn * 1000 };
  ghError = null;
  void finishGithubLogin(ctx, d, fetchFn);
  return json({ userCode: d.userCode, verificationUri: d.verificationUri, expiresIn: d.expiresIn });
}

export const postGithubLogin = (async (ctx) => githubDeviceLogin(ctx)) satisfies Handler;

/** Sign in to a ChatGPT account, from the utility container. */
let codexFlow: CodexLoginFlow | null = null;

/** The codex half of `claudeSettled`, and there for the same reason. */
let codexSettled: Promise<unknown> = Promise.resolve();

export const postCodexDevice = (async (ctx) => {
  if (codexFlow && codexFlow.expiresAt > Date.now()) return json(codexFlow);
  const run = startCodexDeviceLogin(ctx);
  const startedAt = Date.now();
  // Both, or neither: the link alone opens a page asking for a code the boss
  // does not have. codex prints them on two lines, so this waits for the second.
  const both = await printed(run, () => (run.url && run.code ? { url: run.url, code: run.code } : null), 100);
  if (!both) {
    run.cancel();
    // The sandbox verdict is returned as it stands rather than wrapped in a
    // sentence of ours: a descriptor inside another's values is one sentence in
    // two languages, which `values-carry-no-rendered-text` exists to stop. It
    // already reads as the reason, and it is shown beside the button that failed.
    const fault = await sandboxFault(ctx);
    if (fault) return bad(fault);
    return bad(
      msg`codex printed no device code inside the container — run \`codex login --device-auth\` in the image to see why.`,
    );
  }
  codexFlow = { code: both.code, url: both.url, expiresAt: startedAt + DEVICE_CODE_TTL_MS };
  codexSettled = run.done.then(async (r) => {
    codexFlow = null;
    await ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      say: r.ok ? msg`codex is signed in` : msg`codex could not sign in: ${{ detail: r.detail }}`,
    });
  });
  return json(codexFlow);
}) satisfies Handler;

export const postCodexDeviceCancel = (async (_ctx) => {
  currentCodexDeviceLogin()?.cancel();
  codexFlow = null;
  // Bounded for the reason written on `postClaudeCancel`.
  await Promise.race([codexSettled.catch(() => {}), Bun.sleep(SETTLE_GRACE_MS)]);
  return message("ok");
}) satisfies Handler;

/**
 * Each installation, with how many repositories it can see.
 *
 * `per_page=1` because only `total_count` is wanted; fetching a page of repos to
 * count them spends the hourly budget on data nobody reads.
 */
async function withCounts(
  ctx: Ctx,
  list: Installation[],
  signal?: AbortSignal,
): Promise<Array<Installation & { repos: number | null }>> {
  return await Promise.all(
    list.map(async (i) => {
      const r = await ctx.gh!.request(
        "GET",
        `/user/installations/${i.id}/repositories?per_page=1`,
        z.object({ total_count: z.number().int().nonnegative().optional() }),
        undefined,
        signal,
      );
      return { ...i, repos: r.ok ? (r.data.total_count ?? 0) : null };
    }),
  );
}

/** Where the boss installs the app. One app, so one address. */
const INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;

/** `fresh=1` skips the cached snapshot. The `Refresh` path and nothing else. */
export const GithubLoginQuery = z.object({ fresh: z.coerce.boolean().optional() });

/**
 * What the panel knows about the connection, kept rather than re-asked.
 *
 * GitHub's *Best practices for creating a GitHub App* says it directly: **"Rather
 * than calling the `/user` endpoint on every page load, you should handle token
 * validation more strategically"** — store the account by its `id`, and learn
 * about revocation from the `github_app_authorization` webhook or a 401 on a call
 * you actually needed.
 */
/**
 * This route was doing the thing that advises against: two requests to
 * api.github.com every time the pane opened, measured at **1.2s** against a live
 * server while every other settings endpoint answered in 16–160ms.
 *
 * The comment defending it named a real failure — a stored name still saying `Connected`
 * for a token revoked last week — but this is not where that is caught. ADR 029
 * routes a 401 from real work to the boss, holds the project and says so once, and
 * a settings pane nobody has opened cannot notice anything at all.
 */
const SNAPSHOT_KEY = "github_connection";

/**
 * Ten minutes, and the number is about *installations* rather than the account.
 *
 * An account changes when the boss connects a different one, which clears this
 * outright. Installations change on github.com, out of band — so the pane needs
 * some way to notice, and `?fresh=1` is the one the `Refresh` path uses. The TTL is the
 * floor under a reader who never presses it.
 */
const SNAPSHOT_TTL_MS = 10 * 60_000;

const Snapshot = z.object({
  account: z.string().nullable(),
  installed: z.boolean().nullable(),
  // The *normalised* shape, which is what `withCounts` returns and what the panel
  // renders — not GitHub's raw `{ id, account: { login, type } }`. Getting this
  // wrong made the UI's props `unknown`, which the compiler said and a cast would
  // have hidden; validating the read is what turns a stale setting into a type.
  accounts: z.array(z.object({ id: z.number(), account: z.string(), kind: z.string(), repos: z.number().nullable() })),
  at: z.number(),
});

/** Cleared when the GitHub credential changes, beside the commit identity. */
const forgetGithubConnection = async (ctx: Ctx): Promise<void> => {
  if (ctx.db) await writeSetting(ctx.db, SNAPSHOT_KEY, null);
};

/**
 * Ask GitHub, and keep the answer.
 *
 * Its own function rather than an expression inside the handler: the handler is a
 * response shape, and this is two requests and a write.
 */
async function readConnection(ctx: Ctx, gh: NonNullable<Ctx["gh"]>, signal?: AbortSignal) {
  const [account, installs] = await Promise.all([githubAccount(gh, signal), listInstallations(gh, signal)]);
  const snapshot = {
    account,
    installed: account && installs.ok ? installs.data.length > 0 : null,
    accounts: account && installs.ok ? await withCounts(ctx, installs.data, signal) : [],
    at: Date.now(),
  };
  // Only a usable answer is kept. Storing a failed read would turn one
  // unreachable moment into ten minutes of `Connection expired`.
  if (account) await writeSetting(ctx.db, SNAPSHOT_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export const getGithubLogin = (async (ctx, req, _params, query) => {
  const a = await loadAuth(ctx.db, "github");
  const cached = a ? jsonOr(await readSetting(ctx.db, SNAPSHOT_KEY), Snapshot.nullable(), null) : null;
  const usable = cached && !query?.fresh && Date.now() - cached.at < SNAPSHOT_TTL_MS ? cached : null;

  //
  // Authorized is not installed. A GitHub App's user token reaches exactly the
  // repositories the app is installed on, so zero installations is the state that
  // looks like success and is not: a green `Connected` over a repo list that can never
  // fill.
  //
  // Both at once when they do have to be asked. They were serial, and the second
  // only used the first as a truthiness gate — never its data. Overlapping them
  // costs one wasted request when the token has been revoked, which is the case
  // where the panel is about to say `Connection expired` and nobody is waiting on a list.
  const shown = usable ?? (a && ctx.gh ? await readConnection(ctx, ctx.gh, req.signal) : null);
  // Read after the requests above, not before: a code that expired while they
  // were in flight is not a code the panel should still be offering.
  const waiting = livePending();
  return json({
    connected: !!a,
    account: shown?.account ?? null,
    /** The token is stored and GitHub no longer answers for it. */
    stale: !!a && !shown?.account,
    /** Authorized, but the app is not installed anywhere it could read. */
    installed: shown?.installed ?? null,
    installUrl: INSTALL_URL,
    accounts: shown?.accounts ?? [],
    pending: waiting ? { userCode: waiting.userCode, verificationUri: waiting.verificationUri } : null,
    error: ghError,
    /** On this route because both answers come from the connection above. */
    trailers: await trailers(ctx.db),
    identity: await commitIdentity(ctx),
    bot: { ...BOT },
  });
}) satisfies Handler<z.infer<typeof GithubLoginQuery>>;

/** The two switches. Both default on; see `TRAILERS_KEY` for why each exists. */
export const TrailersBody = z.object({
  signoff: z.boolean().optional(),
  coauthor: z.boolean().optional(),
  claudeCoauthor: z.boolean().optional(),
});

export const postTrailers = (async (ctx, _req, _p, b) => {
  return json(
    await setTrailers(ctx.db, Object.fromEntries(Object.entries(b).filter((entry) => entry[1] !== undefined))),
  );
}) satisfies Handler<z.infer<typeof TrailersBody>>;

/**
 * What this login can actually open a project on: which account, and which of
 * its repositories. One route, so the switcher's options and the list it drives
 * cannot disagree.
 */
export const GithubReposQuery = z.object({ installation: z.coerce.number().int().positive().optional() });

export const getGithubRepos = (async (ctx, req, _params, { installation: asked = 0 }) => {
  if (!ctx.gh) return noGithubClient();
  if (!(await loadAuth(ctx.db, "github"))) return bad(msg`GitHub is not connected — connect it in Settings first`);
  // Both at once when the caller names an installation, which it does on every
  // open after the first. The first open of a session still has to learn the id
  // before it can ask.
  const [inst, guess] = await Promise.all([
    listInstallations(ctx.gh, req.signal),
    asked ? listRepos(ctx.gh, asked, req.signal) : Promise.resolve(null),
  ]);
  if (!inst.ok) return badText(inst.message);

  const selected = inst.data.find((i) => i.id === asked)?.id ?? inst.data[0]?.id ?? null;
  const repos = selected === asked ? guess : selected ? await listRepos(ctx.gh, selected, req.signal) : null;
  if (repos && !repos.ok) return badText(repos.message);

  // Seam (007 step 6): a project's identity is still `repo_path`, which for a
  // repository added here is `owner/name`.
  // Which project, not whether: naming it makes an `Added` row a route rather than
  // a dead end.
  const registered = await ctx.db
    .select({ id: project.id, name: project.name, repo_path: project.repo_path })
    .from(project);
  const taken = new Map(registered.map((r) => [r.repo_path, { id: r.id, name: r.name }] as const));
  return json({
    installations: inst.data,
    selected,
    installUrl: INSTALL_URL,
    repos: (repos?.data ?? []).map((r) => ({ ...r, taken: taken.get(r.fullName) ?? null })),
  });
}) satisfies Handler<z.infer<typeof GithubReposQuery>>;
