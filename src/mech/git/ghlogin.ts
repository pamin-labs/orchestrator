import type { Ctx } from "../../mech/ctx.ts";
import { readSetting, writeSetting, type DB } from "../../platform/persistence/database.ts";
import type { Json } from "../../contracts/json.ts";
import { z } from "zod";
/**
 * Connect GitHub once, from the settings page, the way GitHub Desktop does.
 *
 * **Device flow against a GitHub App.** The token exchange needs `client_id`,
 * `device_code` and `grant_type` and *no client secret*, which is the entire
 * reason this is the flow an open-source project can ship. No `scope` either: a
 * GitHub App has none — what the token may do is declared on the app and chosen
 * when it is installed.
 */
/**
 * Plain `fetch`, not `@octokit/auth-oauth-device`: that library blocks until the
 * human comes back, and the panel needs the opposite — hand the code to the
 * browser now, poll in the background, store the token whenever it lands. Its one
 * real asset is the `slow_down` backoff, which is the four lines below.
 */

import type { GhResult, Github } from "./github.ts";
import { pages as paginate } from "./paging.ts";
import { jsonOr } from "../../contracts/json.ts";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const Identity = z.object({ name: z.string(), email: z.string() });

/**
 * The app every install of this orchestrator connects through.
 *
 * Constants, not configuration. A client id is not a secret — the device flow has
 * none at all, which is why this design ships in an open repository — and there is
 * exactly one app. A knob that must never be turned is an invitation to turn it, and
 * the panel section that turned it dropped the stored token when touched.
 *
 * A fork edits these two lines, which is one fewer place to disagree than the yaml.
 */
export const CLIENT_ID = "Iv23liUP6a00TszuLZvc";
export const APP_SLUG = "orchestrator-agentic-app";

/** Only the shape used here, so a test stub is a function rather than a cast. */
export type DeviceFlowFetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<Json | undefined> }>;

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
const Seconds = z.union([z.number().positive(), z.string().regex(/^\d+$/).transform(Number)]);
const DeviceFlowBody = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  device_code: z.string().optional(),
  user_code: z.string().optional(),
  verification_uri: z.url().optional(),
  interval: Seconds.optional(),
  expires_in: Seconds.optional(),
  access_token: z.string().optional(),
});
type DeviceFlowBody = z.infer<typeof DeviceFlowBody>;

async function form(fetchFn: DeviceFlowFetcher, url: string, params: Record<string, string>): Promise<DeviceFlowBody> {
  const r = await fetchFn(url, {
    method: "POST",
    // Without this GitHub answers url-encoded and every field reads as undefined.
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const parsed = DeviceFlowBody.safeParse(await r.json());
  if (!parsed.success) throw new Error("GitHub returned an invalid device-flow response");
  return parsed.data;
}

/** Ask for a code. Returns as soon as there is something to show. */
export async function startDeviceFlow(fetchFn: DeviceFlowFetcher = fetch): Promise<DeviceCode> {
  const b = await form(fetchFn, DEVICE_CODE_URL, { client_id: CLIENT_ID });
  if (b.error || !b.device_code) throw new Error(b.error_description || b.error || "GitHub returned no device code");
  return {
    userCode: b.user_code ?? "",
    verificationUri: b.verification_uri ?? "https://github.com/login/device",
    deviceCode: b.device_code,
    interval: b.interval ?? 5,
    expiresIn: b.expires_in ?? 900,
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
  opts: { fetchFn?: DeviceFlowFetcher; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
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
    if (b.access_token) return b.access_token;
    switch (b.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        interval = b.interval ?? interval + 5;
        break;
      case "expired_token":
        throw new Error("the device code expired — click Connect GitHub again");
      case "access_denied":
        throw new Error("the authorization was denied on GitHub");
      // A `default` as well as the exhaustive cases: GitHub documents errors this
      // switch does not name — `device_flow_disabled`, `incorrect_client_credentials`
      // — and falling through to the loop reported "the code expired" fifteen
      // minutes later, naming the wrong cause.
      case undefined:
      default:
        throw new Error(b.error_description || b.error || "GitHub returned no token");
    }
  }
  throw new Error("the device code expired — click Connect GitHub again");
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

/**
 * What GitHub actually sends back, in the fields read below.
 *
 * Both of these used to arrive as `any` and be mapped by `(i: any)`, so the
 * shape lived only in the property names — `pushed_at` was compared with
 * `Date.parse(b.pushed_at ?? 0)`, which is `Date.parse` handed a number, and
 * nothing could say so.
 */
const GhInstallation = z.object({
  id: z.number().int().positive(),
  account: z.object({ login: z.string().optional(), type: z.string().optional() }).nullable().optional(),
});

const GhRepo = z.object({
  full_name: z.string(),
  private: z.boolean().optional(),
  default_branch: z.string().optional(),
  pushed_at: z.string().nullable().optional(),
  clone_url: z.string().optional(),
});
const InstallationsPage = z.object({ installations: z.array(GhInstallation).optional() });
const RepositoriesPage = z.object({ repositories: z.array(GhRepo).optional() });
const User = z.object({
  login: z.string().optional(),
  id: z.number().int().positive().optional(),
  name: z.string().nullable().optional(),
});

/** The key the list arrives under. It was a `pick` callback for two constants. */
type ListKey = "installations" | "repositories";

/** `github.ts`'s pager, with the key these two endpoints wrap their list in. */
const pages = <T>(
  gh: Github,
  path: string,
  key: ListKey,
  schema: z.ZodType<Partial<Record<ListKey, T[] | undefined>>>,
  signal?: AbortSignal,
): Promise<GhResult<T[]>> => paginate(gh, path, schema, (page) => page?.[key] ?? [], { signal });

/**
 * Where this login can work — one entry per account the app is installed on.
 *
 * Switching org is picking one of these, not logging in again: one user token
 * already sees every installation the user can reach.
 */
export async function listInstallations(gh: Github, signal?: AbortSignal): Promise<GhResult<Installation[]>> {
  const r = await pages(gh, "/user/installations", "installations", InstallationsPage, signal);
  if (!r.ok) return r;
  return {
    ok: true,
    status: r.status,
    data: r.data.map((i) => ({
      id: i.id,
      account: i.account?.login ?? "?",
      kind: i.account?.type ?? "User",
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
export async function listRepos(
  gh: Github,
  installationId: number,
  signal?: AbortSignal,
): Promise<GhResult<RepoRow[]>> {
  const r = await pages(
    gh,
    `/user/installations/${installationId}/repositories`,
    "repositories",
    RepositoriesPage,
    signal,
  );
  if (!r.ok) return r;
  return {
    ok: true,
    status: r.status,
    // Most recently pushed first. GitHub returns them in its own order, which
    // read down the page as 76 months, 51, 4, 61, 72, 71, 14 — and the one the
    // boss wants is almost always the one they touched last.
    data: r.data
      .sort((a, b) => Date.parse(b.pushed_at ?? "") - Date.parse(a.pushed_at ?? ""))
      .map((x) => ({
        fullName: x.full_name,
        private: x.private ?? false,
        defaultBranch: x.default_branch || "main",
        pushedAt: x.pushed_at ? Date.parse(x.pushed_at) || 0 : 0,
        cloneUrl: x.clone_url ?? `https://github.com/${x.full_name}.git`,
      })),
  };
}

/**
 * Which account this token is.
 *
 * Also the only proof it still works, which is why the settings page asks for it
 * rather than reading a name stored beside the token: a stored name keeps saying
 * "connected" for a token GitHub revoked last week (`Decision` 007 §6). `null` means
 * the token no longer answers — deliberately not split into why, because
 * GitHub answers 404 for "cannot see it" as well as "gone".
 */
export async function githubAccount(gh: Github, signal?: AbortSignal): Promise<string | null> {
  const r = await gh.request("GET", "/user", User, undefined, signal);
  return r.ok ? (r.data?.login ?? null) : null;
}

/**
 * Who a commit should be authored by, from the connected account.
 *
 * GitHub's own `noreply` form, and the `id` prefix is **required** —
 * `login@users.noreply.github.com` without it is the legacy form and no longer
 * routes. DCO checks the sign-off against the author, so both come from here.
 */
/**
 * Our GitHub App's bot account, which is a real user on github.com.
 *
 * The account the App already commits as — id resolved from
 * `/users/orchestrator-agentic-app[bot]`, the same shape `claude[bot]` uses. A
 * made-up address routes nowhere, so a `Signed-off-by` carrying it certifies nothing.
 *
 * The fallback and the co-author, never a substitute for a connected human: a bot
 * signing off on a human's behalf is the one thing DCO exists to prevent.
 */
export const BOT = {
  name: `${APP_SLUG}[bot]`,
  email: `317244264+${APP_SLUG}[bot]@users.noreply.github.com`,
} as const;

export async function commitIdentity(ctx: Ctx): Promise<{ name: string; email: string }> {
  const fallback = { ...BOT };
  // Cached: this runs on every checkout, and the answer changes only when the
  // connected account does. `credentialChanged` clears it.
  const cached = jsonOr(ctx.db ? await readSetting(ctx.db, IDENTITY_KEY) : undefined, Identity.nullable(), null);
  if (cached) return cached;
  const r = await ctx.gh?.request("GET", "/user", User);
  if (!r?.ok || !r.data?.login || !r.data?.id) return fallback;
  const who = {
    name: r.data.name || r.data.login,
    email: `${r.data.id}+${r.data.login}@users.noreply.github.com`,
  };
  if (ctx.db) await writeSetting(ctx.db, IDENTITY_KEY, JSON.stringify(who));
  return who;
}

/**
 * The two things a commit carries besides its message, and both default on.
 *
 * **signoff** — a repository enforcing DCO refuses a pull request whose commits
 * lack `Signed-off-by`, and it refuses at the last step of a slice that already
 * passed every gate. Off only for a repository that would reject the trailer.
 */
/**
 * **coauthor** — not an attribution flourish: a diff written by an agent should say
 * so in the record, not only in the pull request body, because the body is where a
 * reader looks once and the commit is where they look a year later. Off for anyone
 * who would rather their history not carry it.
 *
 * Settings rather than yaml: they are decisions about a repository's conventions,
 * and the person making them is looking at the settings page.
 */
const TRAILERS_KEY = "git_trailers";

/** All three on. A record that credits too much is fixable; one that credits
 *  nobody is a diff whose author cannot be asked about it a year later. */
const TRAILER_DEFAULTS: TrailerPrefs = { signoff: true, coauthor: true, claudeCoauthor: true };
const TrailerPrefsPatch = z
  .object({ signoff: z.boolean(), coauthor: z.boolean(), claudeCoauthor: z.boolean() })
  .partial();

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
export async function trailers(db: DB | undefined): Promise<TrailerPrefs> {
  const saved = jsonOr(db ? await readSetting(db, TRAILERS_KEY) : undefined, TrailerPrefsPatch, {});
  return {
    signoff: saved.signoff ?? TRAILER_DEFAULTS.signoff,
    coauthor: saved.coauthor ?? TRAILER_DEFAULTS.coauthor,
    claudeCoauthor: saved.claudeCoauthor ?? TRAILER_DEFAULTS.claudeCoauthor,
  };
}

export async function setTrailers(db: DB, next: Partial<TrailerPrefs>): Promise<TrailerPrefs> {
  const merged = { ...(await trailers(db)), ...next };
  await writeSetting(db, TRAILERS_KEY, JSON.stringify(merged));
  return merged;
}

/** The stored settings, in the shape the commit helpers take. One converter, so
 *  the bot identity cannot drift between the fallback author and the trailer. */
export async function gitTrailers(db: DB | undefined): Promise<{
  signoff: boolean;
  coauthor: boolean;
  bot: { name: string; email: string };
}> {
  return { ...(await trailers(db)), bot: { ...BOT } };
}

/** Cleared when the GitHub credential changes, or it outlives the account. */
const IDENTITY_KEY = "git_identity";
export const forgetIdentity = async (ctx: Ctx): Promise<void> => {
  if (ctx.db) await writeSetting(ctx.db, IDENTITY_KEY, null);
};
