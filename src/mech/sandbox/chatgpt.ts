/**
 * Refreshing a ChatGPT-account login, on the host, once.
 *
 * codex's own answer to CI is "put auth.json on the runner and let codex
 * refresh it", with a warning attached: *do not share the same file across
 * concurrent jobs or multiple machines*. A fleet is exactly that — ten groups,
 * ten sandboxes, one login — so every sandbox refreshing its own copy means
 * they invalidate each other and the boss is asked to log in again.
 *
 * So the orchestrator is the one runner. It holds the file and the sandboxes get
 * decoys, with the sidecar injecting the real access token on the way out — the
 * same arrangement as every other credential.
 *
 * The renewal itself is done by codex, not by us. Posting the refresh token to
 * `auth.openai.com` with the CLI's own client id would work — the endpoint and
 * id are both in the shipped binary — but that is our code presenting itself as
 * the official client, which is exactly the shape the subscription terms are
 * about. One throwaway `codex exec` makes the real client refresh its own
 * token, costs a few hundred tokens, and is needed roughly once a week.
 */

import { jsonOr } from "../util/text.ts";
import { JsonValue, type Json } from "../../http/respond.ts";
import { z } from "zod";

/** Enough to make codex talk to the API, and nothing anyone has to read. */
const NUDGE = ["exec", "--skip-git-repo-check", "-c", 'web_search="disabled"', "reply with: ok"];

const CodexAuthSchema = z
  .object({
    auth_mode: z.string().optional(),
    OPENAI_API_KEY: z.string().nullable().optional(),
    tokens: z
      .object({
        access_token: z.string().optional(),
        id_token: z.string().optional(),
        refresh_token: z.string().optional(),
        account_id: z.string().optional(),
      })
      .catchall(JsonValue)
      .optional(),
    last_refresh: z.string().optional(),
  })
  .catchall(JsonValue);
export type CodexAuth = z.infer<typeof CodexAuthSchema>;

export function parseAuth(json: string): CodexAuth | null {
  return jsonOr(json, CodexAuthSchema.nullable(), null);
}

export const accessToken = (a: CodexAuth): string | null => a.tokens?.access_token ?? null;

/**
 * Old enough to be worth refreshing before a turn spends anything on it.
 *
 * codex treats roughly eight days since `last_refresh` as stale. Half of that
 * is the margin: a turn can run for an hour, and discovering the expiry
 * mid-turn costs the turn.
 */
export function isStale(a: CodexAuth, now = Date.now(), maxAgeMs = 4 * 24 * 3600_000): boolean {
  if (!a.last_refresh) return true;
  const at = Date.parse(a.last_refresh);
  return Number.isNaN(at) || now - at > maxAgeMs;
}

/**
 * Where the refresher's own CODEX_HOME lives, inside the utility container.
 *
 * Not `CODEX_HOME` (`/root/.codex`): every container is given a **decoy**
 * auth.json there, and the refresher needs the real one. Two directories rather
 * than one conditional, so nothing can hand the real login to a codex that was
 * started expecting the decoy.
 */
export const REFRESH_HOME = "/root/.codex-refresh";

/**
 * Reading and writing the refresher's home, and running codex in it.
 *
 * Injected rather than imported so this file stays free of the sandbox module:
 * `sandbox.ts` already imports `auth.ts`, which imports this, and reaching back
 * the other way closes a cycle. The implementation lives with the thing that
 * knows about containers.
 */
export interface CodexHomeIO {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
  /** `rm -f` first, then write. See `seedHome` for why the removal matters. */
  remove(path: string): Promise<void>;
  /** Run `codex <argv>` with CODEX_HOME set. True on exit 0. */
  run(argv: string[]): Promise<boolean>;
}

/**
 * Make codex renew its own login, and hand back the file it wrote.
 *
 * A real call is what triggers the refresh — `codex login status` reports the
 * login without touching it — so this spends the smallest turn it can. Returns
 * null when nothing was renewed, and the caller keeps what it had: a blocked
 * network must not throw away a working login.
 *
 * **The file is the answer, not the exit code.** The nudge can fail on its way
 * out — in the utility container the sidecar replaces the Authorization header
 * with the token we already had, so the API call after a successful refresh can
 * still 401 — and discarding a refreshed `auth.json` because the errand that
 * caused it came back non-zero would throw away the one thing this exists for.
 * Refresh happens at `auth.openai.com`, which nothing binds.
 */
export async function renew(io: CodexHomeIO): Promise<CodexAuth | null> {
  const before = await readAuth(io);
  await io.run(NUDGE);
  const after = await readAuth(io);
  if (!after) return null;
  return after.last_refresh && after.last_refresh !== before?.last_refresh ? after : null;
}

async function readAuth(io: CodexHomeIO): Promise<CodexAuth | null> {
  const text = await io.read(`${REFRESH_HOME}/auth.json`);
  return text ? parseAuth(text) : null;
}

/**
 * The orchestrator's own copy of the login, so renewing it leaves the boss's
 * `~/.codex` alone.
 *
 * Two copies of one login do drift — whichever refreshes last rotates the token
 * out from under the other — but that is the price of using one subscription in
 * two places, and the alternative is a fleet that silently logs the boss out of
 * their own terminal.
 */
export async function seedHome(io: CodexHomeIO, authJson: string): Promise<void> {
  const authPath = `${REFRESH_HOME}/auth.json`;
  // Never through a symlink.
  //
  // This directory holds an *output*: the credential comes from `runtime_auth`
  // and is written here so the host refresher has a CODEX_HOME to run in. Found
  // on a real machine linked to `~/.codex/auth.json` — presumably to avoid
  // re-running `codex login` — and `Bun.write` follows a link, so the weekly
  // refresh would have overwritten and then re-refreshed the boss's own personal
  // login. That is exactly the two-writers-one-token case codex's CI guidance
  // warns about, arriving through the back door.
  //
  // The link is removed rather than honoured: it is ours to write, and refusing
  // instead would leave the refresher permanently unable to run.
  //
  // Still true now that this directory is inside the utility container rather
  // than on the host. The container is ours and starts empty, so the boss's own
  // `~/.codex` is out of reach by construction — but the removal costs one exec
  // and the guarantee it makes is the one that was bought with an incident, so
  // it stays rather than being argued away.
  await io.remove(authPath);
  await io.write(authPath, authJson);
  // Without this codex looks in the OS keychain instead of the file.
  await io.write(`${REFRESH_HOME}/config.toml`, 'cli_auth_credentials_store = "file"\n');
}

/**
 * What a sandbox is given instead of the real thing.
 *
 * Enough for codex to start and believe it is logged in; the sidecar replaces
 * the Authorization header on every request to OpenAI. `last_refresh` is now so
 * that codex does not decide the login is stale and try to refresh a decoy —
 * that call would fail, and the failure would look like an expired account.
 */
export function decoyAuth(a: CodexAuth): string {
  return JSON.stringify({
    auth_mode: a.auth_mode ?? "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: `decoy-${"a".repeat(40)}`,
      // Faked like the other two. This used to pass the *real* `id_token`
      // through, which is a signed JWT identifying the account — a token, inside
      // the sandbox, against the one rule this whole module exists to keep. The
      // old no-real-value fallback was `decoy-iii…`, so codex tolerates a
      // non-JWT here; a structurally valid one is strictly closer to real.
      id_token: decoyIdToken(),
      refresh_token: `decoy-${"r".repeat(40)}`,
      // Not faked, deliberately: `account_id` is an identifier, not a credential
      // — nothing can be signed or replayed with it — and codex addresses the
      // account with it. Faking it would break every codex turn to hide a value
      // the account's own traffic carries anyway.
      account_id: a.tokens?.account_id ?? "",
    },
    last_refresh: new Date().toISOString(),
  });
}

/** A JWT in shape only: three base64url segments, no real claim in it. */
function decoyIdToken(): string {
  const seg = (o: Json) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [
    seg({ alg: "none", typ: "JWT" }),
    seg({ sub: "decoy", exp: Math.floor(Date.now() / 1000) + 86_400 }),
    "d".repeat(43),
  ].join(".");
}
