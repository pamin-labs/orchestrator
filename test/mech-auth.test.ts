import { expect, test } from "bun:test";
import { openMemory } from "../src/platform/persistence/database.ts";
import type { DB } from "../src/platform/persistence/database.ts";
import { loadAuth, saveAuth, vaultBindings } from "../src/mech/sandbox/auth.ts";
import { REFRESH_HOME, type CodexHomeIO } from "../src/mech/sandbox/chatgpt.ts";

/**
 * The one credential that is renewed rather than stored, and the row that owns
 * it.
 *
 * A ChatGPT login is a refresh token plus a short-lived access token, and this
 * is the only writer of either. The rules it has to keep are all invisible when
 * they break:
 *
 *   one writer      a second one replaced the real refresh token with a decoy
 *                   and the whole fleet 401'd, presenting as an expired account
 *   never throw it  a blocked network must keep the login it already has
 *     away
 *   never inside    only the access token is bound at the sidecar; the refresh
 *                   token stays on this side of the boundary
 */

const REFRESH_TOKEN = "rt-do-not-leak-9f2c";
const AUTH = `${REFRESH_HOME}/auth.json`;

function login(accessToken: string, lastRefresh: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: accessToken, refresh_token: REFRESH_TOKEN, account_id: "acct-123456" },
    last_refresh: lastRefresh,
  });
}

const AGES_AGO = new Date(Date.now() - 9 * 24 * 3600_000).toISOString();

/**
 * The utility container's CODEX_HOME, as a map.
 *
 * `renewed` is what a successful `codex exec` leaves behind: a rewritten
 * `auth.json` with a later `last_refresh`. Passing null models the call that
 * changes nothing — a blocked network, or a nudge that failed on its way out.
 */
function codexHome(renewed: string | null): CodexHomeIO & { runs: string[][]; files: Map<string, string> } {
  const files = new Map<string, string>();
  const runs: string[][] = [];
  return {
    files,
    runs,
    read: async (path) => files.get(path) ?? null,
    write: async (path, data) => {
      files.set(path, data);
    },
    remove: async (path) => {
      files.delete(path);
    },
    run: async (argv) => {
      runs.push(argv);
      if (renewed) files.set(AUTH, renewed);
      return true;
    },
  };
}

function withLogin(secret: string) {
  const db = openMemory();
  saveAuth(db, { runtime: "codex", mode: "chatgpt", secret });
  return db;
}

const codexCredential = (v: Awaited<ReturnType<typeof vaultBindings>>) => v.credentials.find((c) => c.name === "codex");

/**
 * The access token as it sits in the row, read through a narrowing rather than a
 * cast: the stored blob is JSON off the database, and a shape change there should
 * fail the test loudly instead of reading `undefined` off `any`.
 */
function storedAccessToken(db: DB): string {
  const stored: unknown = JSON.parse(loadAuth(db, "codex")!.secret);
  if (typeof stored !== "object" || stored === null || !("tokens" in stored)) throw new Error("no tokens in row");
  const tokens: unknown = stored.tokens;
  if (typeof tokens !== "object" || tokens === null || !("access_token" in tokens)) {
    throw new Error("no access_token in row");
  }
  return String(tokens.access_token);
}

test("a stale login is renewed once and the renewal lands in the row, not just the container", async () => {
  // The container's auth.json is scratch — a rebuilt container is reseeded from
  // this row — so a refresh that only updates the container is a refresh that is
  // lost on the next create.
  const db = withLogin(login("at-old", AGES_AGO));
  const io = codexHome(login("at-new", new Date().toISOString()));

  const bound = await vaultBindings(db, io);

  expect(io.runs.length).toBe(1);
  expect(codexCredential(bound)!.value).toBe("at-new");
  expect(storedAccessToken(db)).toBe("at-new");
  // Seeded from the row, and through `remove` first — that write must never
  // follow a symlink into somebody's own ~/.codex.
  expect(io.files.get(`${REFRESH_HOME}/config.toml`)).toContain("cli_auth_credentials_store");
});

test("a fresh login is used as it stands, without spending a call to prove it", async () => {
  const db = withLogin(login("at-fresh", new Date().toISOString()));
  const io = codexHome(login("at-other", new Date().toISOString()));

  const bound = await vaultBindings(db, io);

  expect(io.runs).toEqual([]);
  expect(codexCredential(bound)!.value).toBe("at-fresh");
});

test("a refresh that changes nothing keeps the login it already had", async () => {
  // The nudge can come back non-zero, or come back with the same file, and
  // neither is a reason to drop the one credential nothing else holds.
  const db = withLogin(login("at-old", AGES_AGO));
  const io = codexHome(null);

  const bound = await vaultBindings(db, io);

  expect(io.runs.length).toBe(1);
  expect(codexCredential(bound)!.value).toBe("at-old");
  expect(storedAccessToken(db)).toBe("at-old");
});

test("with no container to renew in, the stored token is still bound", async () => {
  // `vaultBindings(db, null)` is the call that breaks the recursion: building
  // the utility container needs the vault, and the vault must not need the
  // utility container. It has to answer with what is stored, not with nothing.
  const db = withLogin(login("at-old", AGES_AGO));

  expect(codexCredential(await vaultBindings(db, null))!.value).toBe("at-old");
});

test("a login whose auth.json is not readable binds nothing rather than binding junk", async () => {
  const db = openMemory();
  saveAuth(db, { runtime: "codex", mode: "chatgpt", secret: "not json at all" });
  const io = codexHome(login("at-new", new Date().toISOString()));

  const bound = await vaultBindings(db, io);

  expect(codexCredential(bound)).toBeUndefined();
  expect(io.runs).toEqual([]);
});

test("the refresh token never crosses into the container, in a credential or in the environment", async () => {
  // The access token is bound at the sidecar and never enters the container
  // either; the refresh token is the one that cannot be rotated away if it does.
  // A `chatgpt` login also gets no decoy env of its own, so `OPENAI_API_KEY`
  // must not appear carrying anything.
  const db = withLogin(login("at-old", AGES_AGO));
  const io = codexHome(login("at-new", new Date().toISOString()));

  const bound = await vaultBindings(db, io);

  expect(JSON.stringify(bound)).not.toContain(REFRESH_TOKEN);
  expect(bound.env).toEqual({});
});

test("a gateway on the login is bound as a host and as OPENAI_BASE_URL, and only then", async () => {
  const db = openMemory();
  saveAuth(db, {
    runtime: "codex",
    mode: "chatgpt",
    secret: login("at-fresh", new Date().toISOString()),
    baseUrl: "https://gw.example.com/v1",
  });

  const bound = await vaultBindings(db, codexHome(null));

  expect(bound.env.OPENAI_BASE_URL).toBe("https://gw.example.com/v1");
  expect(codexCredential(bound)!.hosts).toContain("gw.example.com");
  // The defaults stay: a gateway is an addition, not a replacement.
  expect(codexCredential(bound)!.hosts).toContain("api.openai.com");
});

test("an API key login has nothing to renew and is left alone", async () => {
  const db = openMemory();
  saveAuth(db, { runtime: "codex", mode: "api_key", secret: "sk-x" });
  const io = codexHome(login("at-new", new Date().toISOString()));

  const bound = await vaultBindings(db, io);

  expect(io.runs).toEqual([]);
  expect(codexCredential(bound)!.value).toBe("sk-x");
});
