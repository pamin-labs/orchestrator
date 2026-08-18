import { z } from "zod";
import type { Ctx } from "../../mech/ctx.ts";
import { release } from "../../mech/flow/intercept.ts";
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
  PASTE_TTL_MS,
  startClaudeLogin,
  startCodexDeviceLogin,
} from "../../mech/sandbox/login.ts";
import { killSandbox, serverKeyOnDisk } from "../../mech/sandbox/sandbox.ts";
import { errText } from "../../platform/process/text.ts";
import type { ClaudeLoginFlow, CodexLoginFlow } from "../../contracts/login-flow.ts";
import type { Handler } from "../../http/handler.ts";
import { bad, json, message } from "../../http/respond.ts";

/**
 * Signing in: to the two model accounts, to GitHub, and to the sandbox server.
 *
 * Three flows with the same shape on purpose — a code, a link, and a pending
 * state that dies with the code — because a second shape for the same
 * interaction is how a settings page stops being learnable. Each keeps one
 * module-level slot: a login nobody finished must not hold it forever, which is
 * what the expiry and the cancel routes are for.
 */

/**
 * Which runtime is configured, and how. Never the secret.
 *
 * The value only ever leaves this process into an egress sidecar's vault, so
 * even the page that sets it reads back a masked tail — enough to tell two
 * tokens apart, which is the only question anyone asks of one they pasted.
 */
// `trailers` rides along: the Claude block draws one of the three switches, and
// a second fetch for one boolean is a second thing that can be stale.
export const getAuth = (async (ctx) =>
  json({ runtimes: listAuth(ctx.db), trailers: trailers(ctx.db) })) satisfies Handler;

/**
 * `secret` is not length-capped and not logged.
 *
 * A pasted `auth.json` is tens of kilobytes and a token is a hundred bytes, so
 * any cap here would be a guess that refuses a real credential — and the failure
 * would read as "the paste is broken". `wrongShape` is what judges it, by shape.
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
    ctx.db.run("DELETE FROM runtime_auth WHERE runtime = ?", [b.runtime]);
    for (const g of ctx.db.query<{ id: number }, []>("SELECT id FROM grp WHERE sandbox_id IS NOT NULL").all()) {
      await killSandbox(ctx, { grp: g.id });
    }
    return message("ok");
  }

  let auth: RuntimeAuth;
  // Read the sandbox server's key out of the server's own config rather than
  // asking the boss to copy one across. The value never reaches the browser.
  if ("adopt" in b) {
    const found = serverKeyOnDisk();
    if (!found)
      return bad(
        "没找到沙盒服务器的配置。它是用 --config 启动的，把那个文件的路径放进 OPENSANDBOX_CONFIG，或者放在 ./sandbox.toml、~/.sandbox.toml。",
      );
    auth = { runtime: SANDBOX_KEY, mode: "api_key", secret: found.key };
  } else {
    auth = b;
  }

  // The sandbox key is ours, not a provider's, so it has no shape to check.
  if (auth.runtime !== SANDBOX_KEY) {
    const wrong = wrongShape(auth);
    if (wrong) return bad(wrong);
  }
  // The sandbox key is the one credential whose owner we can ask, and the one
  // where a wrong value is silent and total: it overrides the environment, so
  // generating one here and not telling the server made every turn, every gate
  // and every diff 401 — reported as "Authentication credentials are invalid",
  // which reads as a model problem. Refused rather than stored.
  if (auth.runtime === SANDBOX_KEY) {
    const said = await sandboxKeyWorks(ctx.config.sandbox?.server ?? "127.0.0.1:8080", auth.secret);
    if (said === "invalid") return bad("沙盒服务器不认这个密钥。它自己的配置里写的是哪个，这里就得填哪个。");
  }
  saveAuth(ctx.db, auth);
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
    // fallow-ignore-next-line security-sink -- `server` is `cfg.sandbox.server`, the address of the boss's own sandbox server, and the key sent with it is the key stored for that same address. Choosing that address is the feature; the panel is loopback-only and no request field reaches this. Same disposition as the probe in `mech/sandbox/server.ts`.
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
 * Existing sandboxes hold the old value in their sidecars. Killing them is the
 * cheap half of the fix — the next turn makes a new one and binds the new
 * credential — and leaving them would mean "I changed it and nothing happened".
 *
 * It lives here rather than inline because there are two ways in and only one of
 * them used to do this: a login from the panel stored the token and stopped,
 * so every running group kept a sidecar bound to the credential that was missing
 * and every turn came back `Authentication credentials are invalid`.
 */
export async function credentialChanged(ctx: Ctx, runtime: string): Promise<void> {
  for (const g of ctx.db.query<{ id: number }, []>("SELECT id FROM grp WHERE sandbox_id IS NOT NULL").all()) {
    await killSandbox(ctx, { grp: g.id });
  }
  const prefix = `${runtime} 的凭据`;
  ctx.db.run(
    `UPDATE escalation SET chain_state = 'answered', answered_by = 'boss', answer = 'reconfigured',
       answered_at = unixepoch() * 1000
     WHERE answer IS NULL AND substr(question, 1, length(?)) = ?`,
    [prefix, prefix],
  );
  // Only the groups this credential stopped. Unscoped, this matched every PAUSED
  // row there was: a group the boss paused by hand restarted itself the moment
  // anyone signed into GitHub, a budget-burnt group resumed with nothing changed
  // about its budget, and a rate-limited one came back carrying `rl_resets_at` —
  // which watchdog rule 6 only clears for rows it still finds PAUSED, so nothing
  // cleared it afterwards either.
  release(ctx, null, { only: `auth:${runtime}` });
  // A different account commits under a different name, and a stale one would
  // sign off as somebody who is no longer connected.
  if (runtime === "github") forgetIdentity(ctx);
  ctx.sched.tick();
}

/**
 * Sign in to a Claude account, from the utility container.
 *
 * Three routes for one thing, because the interaction has three moments and
 * they are minutes apart: the POST returns the link the moment the CLI prints
 * it, the code route carries what the boss pastes back from that page, and
 * cancel exists because a login nobody finished should not sit there holding
 * the one slot.
 *
 * The CLI is `claude setup-token` itself, under a pty, in the container. Nothing
 * here builds a URL or calls a token endpoint — see `startClaudeLogin`.
 *
 * No completion route: `run.done` writes `runtime_auth` itself, so the
 * credential row the panel already polls **is** the confirmation.
 */
let claudeFlow: ClaudeLoginFlow | null = null;

/**
 * Wait for the CLI to print what the boss has to see, or for the run to end.
 *
 * A pty plus a TUI's first paint puts the link a second or two out, so a button
 * that returns before there is one has nothing to show. The run's own exit ends
 * the wait as well: a CLI that printed nothing and quit is already an answer,
 * and sitting out the whole window for it is minutes of spinner over a process
 * that is gone.
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

export const postClaudeLogin = (async (ctx) => {
  if (claudeFlow && claudeFlow.expiresAt > Date.now()) return json(claudeFlow);
  const run = startClaudeLogin(ctx);
  const startedAt = Date.now();
  const url = await printed(run, () => run.url, 150);
  if (!url) {
    run.cancel();
    return bad(
      "容器里的 claude 没打印出登录链接 —— 镜像里跑一下 `claude setup-token` 看看（它需要一个 pty，没有 pty 时它什么都不打印就退出 0）。",
    );
  }
  claudeFlow = { url, expiresAt: startedAt + PASTE_TTL_MS };
  void run.done.then(async (r) => {
    claudeFlow = null;
    if (r.ok) await credentialChanged(ctx, "claude");
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      body: r.ok ? "claude 登录好了" : `claude 登录没成：${r.detail}`,
    });
  });
  return json(claudeFlow);
}) satisfies Handler;

/** The code off that page, handed to the prompt the CLI is sitting at. */
export const CodeBody = z.object({ code: z.string().max(4000).default("") });

export const postClaudeCode = (async (ctx, _req, _p, b) => {
  const code = b.code.trim();
  if (!code) return bad("没有码");
  if (!claudeFlow) return bad("没有在等码的登录 —— 先点登录");
  await startClaudeLogin(ctx).submit(code);
  return message("ok");
}) satisfies Handler<z.infer<typeof CodeBody>>;

export const postClaudeCancel = (async (ctx) => {
  startClaudeLogin(ctx).cancel();
  claudeFlow = null;
  return message("ok");
}) satisfies Handler;

/**
 * Connect GitHub, device flow, no token pasted and no `gh` on this machine.
 *
 * Two routes for one thing, because the flow has two halves that arrive minutes
 * apart: the POST returns the code the moment GitHub mints it — that code *is*
 * the interaction, and a button that waits for the browser has nothing to show —
 * and the GET is what the panel asks while the boss is off in the other tab.
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
 * Its own function, and awaited by nothing in production, because the poll
 * outlives the request that started it — the settings dialog may be closed long
 * before GitHub answers. The device code never leaves here: what the panel is
 * told is the outcome, and a failure carries GitHub's reason, not the exchange.
 */
export async function finishGithubLogin(ctx: Ctx, d: DeviceCode, fetchFn?: DeviceFlowFetcher): Promise<void> {
  try {
    const token = await pollForToken(d, fetchFn ? { fetchFn } : {});
    saveAuth(ctx.db, { runtime: "github", mode: "api_key", secret: token });
    // Every running sandbox holds the old (absent) credential in its sidecar.
    await credentialChanged(ctx, "github");
    ctx.bus.emit({ author: "orchestrator", kind: "state_change", body: "GitHub 连上了" });
  } catch (e) {
    ghError = errText(e);
    ctx.bus.emit({ author: "orchestrator", kind: "state_change", body: `GitHub 没连上：${ghError}` });
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
    // `errText`, not `e?.message`: a thrown non-Error has no `message`, and
    // under `e: any` the fallback `??` handed `bad()` the object itself — a 422
    // whose body reads "[object Object]".
    return bad(errText(e) || "GitHub 没给出登录码");
  }
  ghFlow = { userCode: d.userCode, verificationUri: d.verificationUri, expiresAt: Date.now() + d.expiresIn * 1000 };
  ghError = null;
  void finishGithubLogin(ctx, d, fetchFn);
  return json({ userCode: d.userCode, verificationUri: d.verificationUri, expiresIn: d.expiresIn });
}

export const postGithubLogin = (async (ctx) => githubDeviceLogin(ctx)) satisfies Handler;

/**
 * Sign in to a ChatGPT account, from the utility container.
 *
 * Same shape as the GitHub flow above and deliberately so: a code, a link, and
 * a pending state that dies with the code. A second shape for the same
 * interaction is how a panel stops being learnable.
 *
 * No completion route. `run.done` writes `runtime_auth` itself, so the
 * credential row the panel already polls **is** the confirmation, and the
 * progress lines are already on the live feed.
 */
let codexFlow: CodexLoginFlow | null = null;

export const postCodexDevice = (async (ctx) => {
  if (codexFlow && codexFlow.expiresAt > Date.now()) return json(codexFlow);
  const run = startCodexDeviceLogin(ctx);
  const startedAt = Date.now();
  // Both, or neither: the link alone opens a page asking for a code the boss
  // does not have. codex prints them on two lines, so this waits for the second.
  const both = await printed(run, () => (run.url && run.code ? { url: run.url, code: run.code } : null), 100);
  if (!both) {
    run.cancel();
    return bad("容器里的 codex 没打印出登录码 —— 镜像里跑一下 `codex login --device-auth` 看看。");
  }
  codexFlow = { code: both.code, url: both.url, expiresAt: startedAt + DEVICE_CODE_TTL_MS };
  void run.done.then((r) => {
    codexFlow = null;
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      body: r.ok ? "codex 登录好了" : `codex 登录没成：${r.detail}`,
    });
  });
  return json(codexFlow);
}) satisfies Handler;

export const postCodexDeviceCancel = (async (ctx) => {
  startCodexDeviceLogin(ctx).cancel();
  codexFlow = null;
  return message("ok");
}) satisfies Handler;

/**
 * Each installation, with how many repositories it can see.
 *
 * One extra request per account, asking for a single item — only `total_count` is
 * wanted, and page one of a hundred repositories to count them is the sort of
 * thing that eats a 5000/hour budget quietly. Repeats come back 304 from the
 * client's ETag cache, which does not count against the limit at all.
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

export const getGithubLogin = (async (ctx, req) => {
  const a = loadAuth(ctx.db, "github");
  // Asked of GitHub rather than read from a stored name: a name in the database
  // keeps saying "connected" for a token that was revoked last week, and an
  // expired GitHub token is the failure where every group breaks at once with a
  // different error each (决策 007 §6). No row, no request.
  const account = a && ctx.gh ? await githubAccount(ctx.gh, req.signal) : null;
  // Authorized is not installed. A GitHub App's user token reaches exactly the
  // repositories the app is installed on, so zero installations is the state
  // that looks like success and is not: a green 已连接 over a repo list that
  // can never fill.
  const installs = a && account && ctx.gh ? await listInstallations(ctx.gh, req.signal) : null;
  // Read after the requests above, not before: a code that expired while they
  // were in flight is not a code the panel should still be offering.
  const waiting = livePending();
  return json({
    connected: !!a,
    account,
    /** The token is stored and GitHub no longer answers for it. */
    stale: !!a && !account,
    /** Authorized, but the app is not installed anywhere it could read. */
    installed: installs?.ok ? installs.data.length > 0 : null,
    /** Where to fix that. One app, so one address. */
    installUrl: INSTALL_URL,
    /** Which accounts it is installed on, and how many repositories each can see. */
    accounts: installs?.ok ? await withCounts(ctx, installs.data, req.signal) : [],
    pending: waiting ? { userCode: waiting.userCode, verificationUri: waiting.verificationUri } : null,
    error: ghError,
    /** What every commit carries besides its message, and who it is authored as.
     *  On this route because both answers come from the connection above: the
     *  author is the login, and the two switches are decisions about the
     *  repositories it can reach. */
    trailers: trailers(ctx.db),
    identity: await commitIdentity(ctx),
    bot: { ...BOT },
  });
}) satisfies Handler;

/** The two switches. Both default on; see `TRAILERS_KEY` for why each exists. */
export const TrailersBody = z.object({
  signoff: z.boolean().optional(),
  coauthor: z.boolean().optional(),
  claudeCoauthor: z.boolean().optional(),
});

export const postTrailers = (async (ctx, _req, _p, b) => {
  return json(setTrailers(ctx.db, Object.fromEntries(Object.entries(b).filter((entry) => entry[1] !== undefined))));
}) satisfies Handler<z.infer<typeof TrailersBody>>;

/**
 * What this login can actually open a project on.
 *
 * One route for both halves because they are one question: which account, and
 * which of its repositories. Switching org is picking another installation, not
 * logging in again — so the switcher's options and the list it drives arrive
 * together rather than as two round trips that can disagree.
 */
export const GithubReposQuery = z.object({ installation: z.coerce.number().int().positive().optional() });

export const getGithubRepos = (async (ctx, req, _params, { installation: asked = 0 }) => {
  if (!ctx.gh) return bad("this server has no GitHub client");
  if (!loadAuth(ctx.db, "github")) return bad("还没连 GitHub，先去设置里连一下");
  // Both at once when the caller names an installation, which it does on every
  // open after the first: measured, a round trip to api.github.com is 260-630ms,
  // so doing these in series is a second of blank dialog for no reason. The
  // first open of a session still has to learn the id before it can ask.
  const [inst, guess] = await Promise.all([
    listInstallations(ctx.gh, req.signal),
    asked ? listRepos(ctx.gh, asked, req.signal) : Promise.resolve(null),
  ]);
  if (!inst.ok) return bad(inst.message);

  const selected = inst.data.find((i) => i.id === asked)?.id ?? inst.data[0]?.id ?? null;
  const repos = selected === asked ? guess : selected ? await listRepos(ctx.gh, selected, req.signal) : null;
  if (repos && !repos.ok) return bad(repos.message);

  // Seam (007 step 6): a project's identity is still `repo_path`, which for a
  // repository added here is `owner/name`.
  // Which project, not whether. A greyed-out row saying 已添加 is a dead end: the
  // boss came here to reach that repository and the answer is "it exists
  // somewhere else". Naming it makes the row a route instead.
  const taken = new Map(
    ctx.db
      .query<{ id: number; name: string; repo_path: string }, []>("SELECT id, name, repo_path FROM project")
      .all()
      .map((r) => [r.repo_path, { id: r.id, name: r.name }] as const),
  );
  return json({
    installations: inst.data,
    selected,
    installUrl: INSTALL_URL,
    repos: (repos?.data ?? []).map((r) => ({ ...r, taken: taken.get(r.fullName) ?? null })),
  });
}) satisfies Handler<z.infer<typeof GithubReposQuery>>;
