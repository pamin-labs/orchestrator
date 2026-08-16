import { APP_SLUG, BOT, commitIdentity, forgetIdentity, githubAccount, listInstallations, listRepos, pollForToken, setTrailers, startDeviceFlow, trailers, type Installation } from "../../mech/git/ghlogin.ts";
import { listAuth, loadAuth, SANDBOX_KEY, saveAuth, wrongShape } from "../../mech/sandbox/auth.ts";
import { DEVICE_CODE_TTL_MS, PASTE_TTL_MS, startClaudeLogin, startCodexDeviceLogin } from "../../mech/sandbox/login.ts";
import { killSandbox, serverKeyOnDisk } from "../../mech/sandbox/sandbox.ts";
import { z } from "zod";
import { bad, json, text, type Handler } from "../shared.ts";
import type { Ctx } from "../../ctx.ts";

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
export const getAuth: Handler = async (ctx) => json({ runtimes: listAuth(ctx.db), trailers: trailers(ctx.db) });

/**
 * `secret` is not length-capped and not logged.
 *
 * A pasted `auth.json` is tens of kilobytes and a token is a hundred bytes, so
 * any cap here would be a guess that refuses a real credential — and the failure
 * would read as "the paste is broken". `wrongShape` is what judges it, by shape.
 */
export const AuthBody = z.object({
  runtime: z.string().max(40).default(""),
  mode: z.string().max(40).optional(),
  secret: z.string().optional(),
  baseUrl: z.string().max(2000).optional(),
  clear: z.boolean().optional(),
  adopt: z.boolean().optional(),
});

export const postAuth: Handler<z.infer<typeof AuthBody>> = async (ctx, _req, _p, b) => {
  const runtime = b.runtime.trim();
  let secret = (b.secret ?? "").trim();
  if (!runtime) return bad("which runtime?");
  // Read the sandbox server's key out of the server's own config rather than
  // asking the boss to copy one across. Generating a key here and trusting a
  // human to mirror it is how the fleet spent a night 401ing: the panel had one
  // value, the server had another, and nothing on either side could see both.
  // The value never reaches the browser — it goes config file to store.
  if (b.adopt) {
    if (runtime !== SANDBOX_KEY) return bad("adopt is only for the sandbox server");
    const found = serverKeyOnDisk();
    if (!found)
      return bad(
        "没找到沙盒服务器的配置。它是用 --config 启动的，把那个文件的路径放进 OPENSANDBOX_CONFIG，或者放在 ./sandbox.toml、~/.sandbox.toml。",
      );
    secret = found.key;
  }
  // Something wrong got stored — a login URL pasted into the token box, an old
  // account. Removing it is the only way back to "not configured", which is a
  // state the scheduler and the panel both understand.
  if (b.clear) {
    ctx.db.run("DELETE FROM runtime_auth WHERE runtime = ?", [runtime]);
    for (const g of ctx.db.query<{ id: number }, []>("SELECT id FROM grp WHERE sandbox_id IS NOT NULL").all()) {
      await killSandbox(ctx, { grp: g.id });
    }
    return text("ok");
  }
  if (!secret) return bad("paste the token or key");
  if (b.mode !== "oauth_token" && b.mode !== "api_key" && b.mode !== "chatgpt")
    return bad("mode is oauth_token, api_key or chatgpt");
  // The sandbox key is ours, not a provider's, so it has no shape to check.
  if (runtime !== SANDBOX_KEY) {
    const wrong = wrongShape(runtime, b.mode, secret);
    if (wrong) return bad(wrong);
  }
  if (b.baseUrl) {
    try {
      new URL(b.baseUrl);
    } catch {
      return bad(`${b.baseUrl} is not a URL`);
    }
  }
  // The sandbox key is the one credential whose owner we can ask, and the one
  // where a wrong value is silent and total: it overrides the environment, so
  // generating one here and not telling the server made every turn, every gate
  // and every diff 401 — reported as "Authentication credentials are invalid",
  // which reads as a model problem. Refused rather than stored.
  if (runtime === SANDBOX_KEY) {
    const said = await sandboxKeyWorks(ctx.config.sandbox?.server ?? "127.0.0.1:8080", secret);
    if (said === "invalid") return bad("沙盒服务器不认这个密钥。它自己的配置里写的是哪个，这里就得填哪个。");
  }
  saveAuth(ctx.db, { runtime, mode: b.mode, secret, baseUrl: b.baseUrl || undefined });
  await credentialChanged(ctx, runtime);
  return text("ok");
};

/**
 * Ask the sandbox server whether it would accept this key.
 *
 * `unknown` when it cannot be reached: a server that is down is a preflight
 * finding, not a reason to refuse a key that may well be right.
 */
async function sandboxKeyWorks(server: string, key: string): Promise<"ok" | "invalid" | "unknown"> {
  try {
    const r = await fetch(`http://${server}/v1/sandboxes`, {
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
  for (const g of ctx.db
    .query<{ id: number }, []>("SELECT id FROM grp WHERE sandbox_id IS NOT NULL")
    .all()) {
    await killSandbox(ctx, { grp: g.id });
  }
  ctx.db.run(
    `UPDATE escalation SET chain_state = 'answered', answered_by = 'boss', answer = 'reconfigured',
       answered_at = unixepoch() * 1000
     WHERE answer IS NULL AND question LIKE ?`,
    [`${runtime} 的凭据%`],
  );
  // Only the groups this credential stopped. Unscoped, this matched every PAUSED
  // row there was: a group the boss paused by hand restarted itself the moment
  // anyone signed into GitHub, a budget-burnt group resumed with nothing changed
  // about its budget, and a rate-limited one came back carrying `rl_resets_at` —
  // which watchdog rule 6 only clears for rows it still finds PAUSED, so nothing
  // cleared it afterwards either.
  ctx.db.run("UPDATE grp SET status = 'RUNNING', paused_at = NULL, pause_reason = NULL WHERE pause_reason = ?", [
    `auth:${runtime}`,
  ]);
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
interface ClaudeFlow {
  url: string;
  expiresAt: number;
}
let claudeFlow: ClaudeFlow | null = null;

export const postClaudeLogin: Handler = async (ctx) => {
  if (claudeFlow && claudeFlow.expiresAt > Date.now()) return json(claudeFlow);
  const run = startClaudeLogin(ctx);
  const startedAt = Date.now();
  // A pty plus a TUI's first paint: the link is a second or two out, and a
  // button that returns before it has one has nothing to show.
  for (let i = 0; i < 150 && !run.url; i++) await Bun.sleep(100);
  if (!run.url) {
    run.cancel();
    return bad(
      "容器里的 claude 没打印出登录链接 —— 镜像里跑一下 `claude setup-token` 看看（它需要一个 pty，没有 pty 时它什么都不打印就退出 0）。",
    );
  }
  claudeFlow = { url: run.url, expiresAt: startedAt + PASTE_TTL_MS };
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
};

/** The code off that page, handed to the prompt the CLI is sitting at. */
export const CodeBody = z.object({ code: z.string().max(4000).default("") });

export const postClaudeCode: Handler<z.infer<typeof CodeBody>> = async (ctx, _req, _p, b) => {
  const code = b.code.trim();
  if (!code) return bad("没有码");
  if (!claudeFlow) return bad("没有在等码的登录 —— 先点登录");
  await startClaudeLogin(ctx).submit(code);
  return text("ok");
};

export const postClaudeCancel: Handler = async (ctx) => {
  startClaudeLogin(ctx).cancel();
  claudeFlow = null;
  return text("ok");
};

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

export const postGithubLogin: Handler = async (ctx) => {
  // A second click while one code is still good hands back the same code rather
  // than starting a second poll: two loops racing for one login is two ways to
  // store a token and one of them wins silently.
  if (ghFlow && ghFlow.expiresAt > Date.now()) {
    return json({ userCode: ghFlow.userCode, verificationUri: ghFlow.verificationUri, expiresIn: Math.round((ghFlow.expiresAt - Date.now()) / 1000) });
  }
  let d: Awaited<ReturnType<typeof startDeviceFlow>>;
  try {
    d = await startDeviceFlow();
  } catch (e: any) {
    return bad(e?.message ?? "GitHub 没给出登录码");
  }
  ghFlow = { userCode: d.userCode, verificationUri: d.verificationUri, expiresAt: Date.now() + d.expiresIn * 1000 };
  ghError = null;

  void (async () => {
    try {
      const token = await pollForToken(d);
      saveAuth(ctx.db, { runtime: "github", mode: "api_key", secret: token });
      // Every running sandbox holds the old (absent) credential in its sidecar.
      await credentialChanged(ctx, "github");
      ctx.bus.emit({ author: "orchestrator", kind: "state_change", body: "GitHub 连上了" });
    } catch (e: any) {
      ghError = e?.message ?? String(e);
      ctx.bus.emit({ author: "orchestrator", kind: "state_change", body: `GitHub 没连上：${ghError}` });
    } finally {
      ghFlow = null;
    }
  })();

  return json({ userCode: d.userCode, verificationUri: d.verificationUri, expiresIn: d.expiresIn });
};

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
interface CodexFlow {
  code: string;
  url: string;
  expiresAt: number;
}
let codexFlow: CodexFlow | null = null;

export const postCodexDevice: Handler = async (ctx) => {
  if (codexFlow && codexFlow.expiresAt > Date.now()) return json(codexFlow);
  const run = startCodexDeviceLogin(ctx);
  const startedAt = Date.now();
  // Both, or neither: the link alone opens a page asking for a code the boss
  // does not have. codex prints them on two lines, so this waits for the second.
  for (let i = 0; i < 100 && !(run.url && run.code); i++) await Bun.sleep(100);
  if (!run.url || !run.code) {
    run.cancel();
    return bad("容器里的 codex 没打印出登录码 —— 镜像里跑一下 `codex login --device-auth` 看看。");
  }
  codexFlow = { code: run.code, url: run.url, expiresAt: startedAt + DEVICE_CODE_TTL_MS };
  void run.done.then((r) => {
    codexFlow = null;
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      body: r.ok ? "codex 登录好了" : `codex 登录没成：${r.detail}`,
    });
  });
  return json(codexFlow);
};

export const postCodexDeviceCancel: Handler = async (ctx) => {
  startCodexDeviceLogin(ctx).cancel();
  codexFlow = null;
  return text("ok");
};

/**
 * Each installation, with how many repositories it can see.
 *
 * One extra request per account, asking for a single item — only `total_count` is
 * wanted, and page one of a hundred repositories to count them is the sort of
 * thing that eats a 5000/hour budget quietly. Repeats come back 304 from the
 * client's ETag cache, which does not count against the limit at all.
 */
async function withCounts(ctx: Ctx, list: Installation[]): Promise<Array<Installation & { repos: number | null }>> {
  return await Promise.all(
    list.map(async (i) => {
      const r = await ctx.gh!.request<{ total_count?: number }>(
        "GET",
        `/user/installations/${i.id}/repositories?per_page=1`,
      );
      return { ...i, repos: r.ok ? (Number(r.data?.total_count) || 0) : null };
    }),
  );
}

/** Where the boss installs the app. One app, so one address. */
const INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;

export const getGithubLogin: Handler = async (ctx) => {
  const a = loadAuth(ctx.db, "github");
  // Asked of GitHub rather than read from a stored name: a name in the database
  // keeps saying "connected" for a token that was revoked last week, and an
  // expired GitHub token is the failure where every group breaks at once with a
  // different error each (决策 007 §6). No row, no request.
  const account = a && ctx.gh ? await githubAccount(ctx.gh) : null;
  // Authorized is not installed. A GitHub App's user token reaches exactly the
  // repositories the app is installed on, so zero installations is the state
  // that looks like success and is not: a green 已连接 over a repo list that
  // can never fill.
  const installs = a && account && ctx.gh ? await listInstallations(ctx.gh) : null;
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
    accounts: installs?.ok ? await withCounts(ctx, installs.data) : [],
    pending: ghFlow && ghFlow.expiresAt > Date.now() ? { userCode: ghFlow.userCode, verificationUri: ghFlow.verificationUri } : null,
    error: ghError,
    /** What every commit carries besides its message, and who it is authored as.
     *  On this route because both answers come from the connection above: the
     *  author is the login, and the two switches are decisions about the
     *  repositories it can reach. */
    trailers: trailers(ctx.db),
    identity: await commitIdentity(ctx),
    bot: { ...BOT },
  });
};

/** The two switches. Both default on; see `TRAILERS_KEY` for why each exists. */
export const TrailersBody = z.object({
  signoff: z.boolean().optional(),
  coauthor: z.boolean().optional(),
  claudeCoauthor: z.boolean().optional(),
});

export const postTrailers: Handler<z.infer<typeof TrailersBody>> = async (ctx, _req, _p, b) => {
  return json(setTrailers(ctx.db, b));
};

/**
 * What this login can actually open a project on.
 *
 * One route for both halves because they are one question: which account, and
 * which of its repositories. Switching org is picking another installation, not
 * logging in again — so the switcher's options and the list it drives arrive
 * together rather than as two round trips that can disagree.
 */
export const getGithubRepos: Handler = async (ctx, req) => {
  if (!ctx.gh) return bad("this server has no GitHub client");
  if (!loadAuth(ctx.db, "github")) return bad("还没连 GitHub，先去设置里连一下");
  // Both at once when the caller names an installation, which it does on every
  // open after the first: measured, a round trip to api.github.com is 260-630ms,
  // so doing these in series is a second of blank dialog for no reason. The
  // first open of a session still has to learn the id before it can ask.
  const asked = Number(new URL(req.url).searchParams.get("installation")) || 0;
  const [inst, guess] = await Promise.all([
    listInstallations(ctx.gh),
    asked ? listRepos(ctx.gh, asked) : Promise.resolve(null),
  ]);
  if (!inst.ok) return bad(inst.message);

  const selected = inst.data.find((i) => i.id === asked)?.id ?? inst.data[0]?.id ?? null;
  const repos = selected === asked ? guess : selected ? await listRepos(ctx.gh, selected) : null;
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
};
