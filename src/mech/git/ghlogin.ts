import type { Ctx } from "../../ctx.ts";
import type { DB } from "../../db.ts";
/**
 * Connect GitHub once, from the settings page, the way GitHub Desktop does.
 *
 * **Device flow, against a GitHub App.** A code on screen, a browser tab,
 * nothing pasted and no `gh` binary. The token exchange needs `client_id`,
 * `device_code` and `grant_type` and *no client secret* — which is the entire
 * reason this is the flow an open-source project can ship. The client id is not
 * a secret and lives in `config/default.yaml`.
 *
 * No `scope` parameter: a GitHub App has no OAuth scopes. What the token may do
 * is declared on the app and chosen when it is installed, so sending one would
 * be ignored at best.
 *
 * Plain `fetch`, not `@octokit/auth-oauth-device`: that library's shape is
 * "block until the human comes back, calling `onVerification` on the way", and
 * what the panel needs is the opposite — hand the code to the browser now, poll
 * in the background, store the token whenever it lands. Its one real asset is
 * the `slow_down` backoff, which is the four lines below. Same call as
 * decision 007 made against `@octokit/rest` for eight endpoints.
 */

import type { GhResult, Github } from "./github.ts";
import { jsonOr } from "../util/text.ts";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * The app every install of this orchestrator connects through.
 *
 * Constants, not configuration. A client id is not a secret — the device flow
 * has none at all, which is the whole reason this design ships in an open
 * repository — and there is exactly one app: everyone using this connects
 * through it. A knob that must never be turned is an invitation to turn it, and
 * the panel section that turned it dropped the stored token when touched.
 *
 * Someone running their own fork edits these two lines, which is the same act as
 * editing the yaml and one fewer place for the two to disagree.
 */
export const CLIENT_ID = "Iv23liUP6a00TszuLZvc";
export const APP_SLUG = "orchestrator-agentic-app";

/** Only the shape used here, so a test stub is a function rather than a cast. */
export type Fetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export interface DeviceCode {
  /** The eight characters the boss types into github.com. The whole interaction. */
  userCode: string;
  verificationUri: string;
  /** Ours, never shown: this is what the poll trades for a token. */
  deviceCode: string;
  /** Seconds between polls. GitHub rate-limits a faster one. */
  interval: number;
  expiresIn: number;
}

/**
 * The device-flow fields anything below reads.
 *
 * Every one is `String()`d or `Number()`d at its use already — this only stops
 * the return being `any`, which let `b.<anything>` compile at four call sites
 * that are reading a form-encoded reply from another host.
 */
interface DeviceFlowBody {
  error?: string;
  error_description?: string;
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  interval?: string | number;
  expires_in?: string | number;
  access_token?: string;
}

async function form(fetchFn: Fetcher, url: string, params: Record<string, string>): Promise<DeviceFlowBody> {
  const r = await fetchFn(url, {
    method: "POST",
    // Without this GitHub answers url-encoded and every field reads as undefined.
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`GitHub 回了 ${r.status}`);
  return await r.json();
}

/** Ask for a code. Returns as soon as there is something to show. */
export async function startDeviceFlow(fetchFn: Fetcher = fetch): Promise<DeviceCode> {
  const b = await form(fetchFn, DEVICE_CODE_URL, { client_id: CLIENT_ID });
  if (b.error || !b.device_code) throw new Error(b.error_description || b.error || "GitHub 没给出登录码");
  return {
    userCode: String(b.user_code),
    verificationUri: String(b.verification_uri ?? "https://github.com/login/device"),
    deviceCode: String(b.device_code),
    interval: Number(b.interval) || 5,
    expiresIn: Number(b.expires_in) || 900,
  };
}

/**
 * Wait for the browser, then hand back the token.
 *
 * Four answers, not one. `slow_down` is the one a hand-rolled loop forgets, and
 * forgetting it is how the poll gets rate-limited into `expired_token` — GitHub
 * says what the new interval is, and its documented floor is +5 seconds when it
 * does not.
 */
export async function pollForToken(
  d: DeviceCode,
  opts: { fetchFn?: Fetcher; sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? Bun.sleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + d.expiresIn * 1000;
  let interval = d.interval;

  while (now() < deadline) {
    await sleep(interval * 1000);
    const b = await form(fetchFn, TOKEN_URL, {
      client_id: CLIENT_ID,
      device_code: d.deviceCode,
      grant_type: GRANT_TYPE,
    });
    if (b.access_token) return String(b.access_token);
    switch (b.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        interval = Number(b.interval) || interval + 5;
        break;
      case "expired_token":
        throw new Error("登录码过期了，重新点一次「连接 GitHub」");
      case "access_denied":
        throw new Error("在 GitHub 上拒绝了这次授权");
      default:
        throw new Error(b.error_description || b.error || "GitHub 没给出 token");
    }
  }
  throw new Error("登录码过期了，重新点一次「连接 GitHub」");
}

/**
 * Everything past the login is ordinary REST, so it goes through the one client
 * (`mech/github.ts`) rather than a second `fetch` in this file: that one already
 * carries the token, the ETags a 304 needs to stay off the rate limit, and the
 * boss/agent/transient split.
 */

/** One place the app is installed: a user account or an org. The org switcher. */
export interface Installation {
  id: number;
  account: string;
  /** `User` or `Organization`. */
  kind: string;
}

export interface RepoRow {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  /** Epoch ms, 0 if it has never been pushed to. */
  pushedAt: number;
  cloneUrl: string;
}

/**
 * Every page, not the first hundred.
 *
 * By page number rather than by the `Link` header: the shared client hands back
 * parsed JSON and keeps the headers to itself, and a short page is the same
 * end-of-list signal for these two endpoints. The cap is there so a bug in that
 * reasoning costs ten requests instead of the hour's whole budget.
 */
const PER_PAGE = 100;

/**
 * What GitHub actually sends back, in the fields read below.
 *
 * Both of these used to arrive as `any` and be mapped by `(i: any)`, so the
 * shape lived only in the property names — `pushed_at` was compared with
 * `Date.parse(b.pushed_at ?? 0)`, which is `Date.parse` handed a number, and
 * nothing could say so.
 */
interface GhInstallation {
  id: number;
  account?: { login?: string; type?: string };
}

interface GhRepo {
  full_name: string;
  private?: boolean;
  default_branch?: string;
  pushed_at?: string;
  clone_url?: string;
}

/** The key the list arrives under. It was a `pick` callback for two constants. */
type ListKey = "installations" | "repositories";

async function pages<T>(gh: Github, path: string, key: ListKey): Promise<GhResult<T[]>> {
  const out: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await gh.request<Partial<Record<ListKey, T[]>>>("GET", `${path}?per_page=${PER_PAGE}&page=${page}`);
    if (!r.ok) return r;
    const items = r.data?.[key] ?? [];
    out.push(...items);
    if (items.length < PER_PAGE) break;
  }
  return { ok: true, status: 200, data: out };
}

/**
 * Where this login can work — one entry per account the app is installed on.
 *
 * Switching org is picking one of these, not logging in again: one user token
 * already sees every installation the user can reach.
 */
export async function listInstallations(gh: Github): Promise<GhResult<Installation[]>> {
  const r = await pages<GhInstallation>(gh, "/user/installations", "installations");
  if (!r.ok) return r;
  return {
    ok: true,
    status: r.status,
    data: r.data.map((i) => ({
      id: Number(i.id),
      account: String(i.account?.login ?? "?"),
      kind: String(i.account?.type ?? "User"),
    })),
  };
}

/**
 * The repositories of one installation.
 *
 * `/user/installations/{id}/repositories`, **not** `/user/repos`. The second is
 * the OAuth App answer and lists everything the *user* can see, including the
 * repositories this app was never installed on — and a project made from one of
 * those fails at its first clone with a 404 that cannot say why, because GitHub
 * answers 404 rather than 403 for what a token cannot see.
 */
export async function listRepos(gh: Github, installationId: number): Promise<GhResult<RepoRow[]>> {
  const r = await pages<GhRepo>(gh, `/user/installations/${installationId}/repositories`, "repositories");
  if (!r.ok) return r;
  return {
    ok: true,
    status: r.status,
    // Most recently pushed first. GitHub returns them in its own order, which
    // read down the page as 76 months, 51, 4, 61, 72, 71, 14 — and the one the
    // boss wants is almost always the one they touched last.
    data: r.data.sort((a, b) => Date.parse(b.pushed_at ?? "") - Date.parse(a.pushed_at ?? "")).map((x) => ({
      fullName: String(x.full_name),
      private: !!x.private,
      defaultBranch: String(x.default_branch || "main"),
      pushedAt: x.pushed_at ? Date.parse(x.pushed_at) || 0 : 0,
      cloneUrl: String(x.clone_url ?? `https://github.com/${x.full_name}.git`),
    })),
  };
}

/**
 * Which account this token is.
 *
 * Also the only proof it still works, which is why the settings page asks for it
 * rather than reading a name stored beside the token: a stored name keeps saying
 * "connected" for a token GitHub revoked last week (决策 007 §6). `null` means
 * the token no longer answers — deliberately not split into why, because
 * GitHub answers 404 for "cannot see it" as well as "gone".
 */
export async function githubAccount(gh: Github): Promise<string | null> {
  const r = await gh.request<{ login?: string }>("GET", "/user");
  return r.ok ? (r.data?.login ?? null) : null;
}

/**
 * Who a commit should be authored by, from the connected account.
 *
 * The identity was a literal — `orch agent <agent@orch.local>` — which is fine
 * until a repository enforces DCO: the sign-off line has to match the author,
 * and a made-up address is not an identity anybody can be said to have signed
 * as. The connected login is one, and it is already here.
 *
 * The `noreply` address is GitHub's own form, and the right one to use: it is
 * what the web UI commits as, it is accepted by DCO checks, and it does not
 * publish an address the account holder may not want in a commit log. The `id`
 * prefix is required — `login@users.noreply.github.com` without it is the legacy
 * form and no longer routes.
 */
/**
 * Our GitHub App's bot account, which is a real user on github.com.
 *
 * `orch agent <agent@orch.local>` was made up: the address routes nowhere and
 * the name belongs to nobody, so a `Signed-off-by` line carrying it certifies
 * nothing and a reviewer clicking the author gets a 404. This is the account the
 * App already commits as — id resolved from `/users/orchestrator-agentic-app[bot]`,
 * in GitHub's own noreply form, the same shape `claude[bot]` uses.
 *
 * It is the fallback and the co-author, never a substitute for a connected
 * human: a bot signing off on a human's behalf is the one thing DCO exists to
 * prevent.
 */
export const BOT = {
  name: `${APP_SLUG}[bot]`,
  email: `317244264+${APP_SLUG}[bot]@users.noreply.github.com`,
} as const;

export async function commitIdentity(ctx: Ctx): Promise<{ name: string; email: string }> {
  const fallback = { ...BOT };
  // Cached: this runs on every checkout, and the answer changes only when the
  // connected account does. `credentialChanged` clears it.
  const held = ctx.db
    ?.query<{ v: string }, [string]>("SELECT v FROM setting WHERE k = ?")
    .get(IDENTITY_KEY)?.v;
  const cached = jsonOr<{ name: string; email: string } | null>(held, null);
  if (cached) return cached;
  const r = await ctx.gh?.request<{ login?: string; id?: number; name?: string | null }>("GET", "/user");
  if (!r?.ok || !r.data?.login || !r.data?.id) return fallback;
  const who = {
    name: r.data.name || r.data.login,
    email: `${r.data.id}+${r.data.login}@users.noreply.github.com`,
  };
  ctx.db?.run("INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [
    IDENTITY_KEY,
    JSON.stringify(who),
  ]);
  return who;
}

/**
 * The two things a commit carries besides its message, and both default on.
 *
 * **signoff** — a repository enforcing DCO refuses a pull request whose commits
 * lack `Signed-off-by`, and it refuses at the last step of a slice that already
 * passed every gate. Off only for a repository that would reject the trailer.
 *
 * **coauthor** — `Co-Authored-By: orchestrator-agentic-app[bot]`. Not an attribution
 * flourish: a diff written by an agent should say so in the record, not only in
 * the pull request body, because the body is where a reader looks once and the
 * commit is where they look a year later. Off for anyone who would rather their
 * history not carry it.
 *
 * Settings rather than yaml: they are decisions about a repository's
 * conventions, and the person making them is looking at the settings page.
 */
export const TRAILERS_KEY = "git_trailers";

/** All three on. A record that credits too much is fixable; one that credits
 *  nobody is a diff whose author cannot be asked about it a year later. */
const TRAILER_DEFAULTS: TrailerPrefs = { signoff: true, coauthor: true, claudeCoauthor: true };

export interface TrailerPrefs {
  signoff: boolean;
  coauthor: boolean;
  /**
   * Claude Code's own trailer, which is a different decision than ours.
   *
   * The CLI appends `Co-Authored-By: Claude` and a `Generated with Claude Code`
   * line to any commit it makes itself. That is a fact about the tool that wrote
   * the diff, not about this project's conventions — somebody can want the model
   * credited and not the orchestrator, or the reverse — so it is its own switch,
   * and it lives beside the Claude account rather than beside the git ones.
   */
  claudeCoauthor: boolean;
}

/** What a commit helper takes: the two settings it acts on, plus who the
 *  co-author is. Not all of `TrailerPrefs` — `claudeCoauthor` is a setting for
 *  the CLI inside the sandbox and means nothing to a `git commit` here. */
export interface Trailers extends Pick<TrailerPrefs, "signoff" | "coauthor"> {
  /** Always `BOT`. A field rather than an import inside `withTrailers` so the
   *  commit helpers stay pure and testable without a database. */
  bot: { name: string; email: string };
}

/** Takes the database, not a `Ctx`: the sandbox writes Claude Code's own
 *  co-author setting from the same row, and it has no `Ctx` to hand. */
export function trailers(db: DB | undefined): TrailerPrefs {
  const row = db?.query<{ v: string }, [string]>("SELECT v FROM setting WHERE k = ?").get(TRAILERS_KEY)?.v;
  return { ...TRAILER_DEFAULTS, ...jsonOr<Partial<TrailerPrefs>>(row, {}) };
}

export function setTrailers(db: DB, next: Partial<TrailerPrefs>): TrailerPrefs {
  const merged = { ...trailers(db), ...next };
  db.run("INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [
    TRAILERS_KEY,
    JSON.stringify(merged),
  ]);
  return merged;
}

/** The stored settings, in the shape the commit helpers take. One converter, so
 *  the bot identity cannot drift between the fallback author and the trailer. */
export function gitTrailers(ctx: Ctx): { signoff: boolean; coauthor: boolean; bot: { name: string; email: string } } {
  return { ...trailers(ctx.db), bot: { ...BOT } };
}

/** Cleared when the GitHub credential changes, or it outlives the account. */
export const IDENTITY_KEY = "git_identity";
export const forgetIdentity = (ctx: Ctx): void => void ctx.db?.run("DELETE FROM setting WHERE k = ?", [IDENTITY_KEY]);
