import { expect, test } from "bun:test";
import { errText } from "../../src/platform/process/text.ts";
import { isLoopback } from "../../src/contracts/config.ts";
import {
  DATABASE_URL,
  hostnameOf,
  isRefused,
  open,
  shouldStartLocal,
} from "../../src/platform/persistence/database.ts";

/**
 * A database that refuses is the most common way this process fails to start,
 * and it was the one failure with nothing to read.
 *
 * `open()` named `ORCH_DATABASE_URL` when it was unset and said nothing at all
 * when it was set and wrong: the caller got `DrizzleQueryError: Failed query:
 * CREATE SCHEMA IF NOT EXISTS "drizzle"` wrapping `ERR_POSTGRES_CONNECTION_
 * REFUSED`, naming neither the address it tried nor a way out.
 */
/** ADR 051 required both — "a failure names both ways out" — and delivered them only for the compose half. */

/** A port in the ephemeral range with nothing on it. Refused, not filtered. */
const NOBODY = "postgres://orchestrator:hunter2@127.0.0.1:5499/orchestrator";

const caught = async (url: string): Promise<unknown> => {
  try {
    await open(undefined, url);
  } catch (e) {
    return e;
  }
  throw new Error(`${url} answered, so this test proves nothing`);
};

const why = async (url: string): Promise<string> => errText(await caught(url), 2000);

test("a refused connection names the address it tried", async () => {
  const text = await why(NOBODY);
  expect(text).toContain("127.0.0.1:5499");
  expect(text).toContain("orchestrator");
});

test("a refused connection never prints the password", async () => {
  // The whole string, not the `password` field: a URL spliced into a message
  // carries it in the middle of the authority, which is exactly how a credential
  // reaches a terminal, a CI log and a screenshot at once.
  expect(await why(NOBODY)).not.toContain("hunter2");
});

test("a refused connection names both ways out", async () => {
  const text = await why(NOBODY);
  expect(text).toContain(DATABASE_URL);
  expect(text).toContain("db:up");
});

/**
 * The two predicates the fallback is made of.
 *
 * `server.ts` starts the local container for a connection string that is
 * refused *and* names this machine, and for nothing else. Both halves matter and
 * they fail in opposite directions: drop the first and a bad password spawns a
 * container, drop the second and a managed PostgreSQL having a bad minute gets
 * an empty local database started beside it and written to, which nothing would
 * report.
 */
test("a refusal is told apart from every other way opening fails", async () => {
  expect(isRefused(await caught(NOBODY))).toBe(true);
  // The shape of a migration or permission failure: an Error chain with no
  // connection code anywhere in it.
  expect(isRefused(new Error("relation does not exist", { cause: new Error("42P01") }))).toBe(false);
  expect(isRefused("not an error at all")).toBe(false);
});

test("the three spellings of this machine are recognised, and a remote host is not", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    expect(isLoopback(hostnameOf(`postgres://u:p@${host}:5432/orchestrator`))).toBe(true);
  }
  expect(isLoopback(hostnameOf("postgres://u:p@db.example.com:5432/orchestrator"))).toBe(false);
  // A string that is not a URL names no host, so it can never be mistaken for
  // this machine — which is the safe direction: no fallback, and A1's message.
  expect(isLoopback(hostnameOf("not a url"))).toBe(false);
});

test("a container is started for a refused local database and for nothing else", async () => {
  const refused = await caught(NOBODY);
  const other = new Error("password authentication failed", { cause: new Error("28P01") });

  expect(shouldStartLocal(NOBODY, refused)).toBe(true);
  // Same failure, somebody else's database. Starting an empty one here and
  // writing to it is the data split.
  expect(shouldStartLocal("postgres://u:p@db.example.com:5432/orchestrator", refused)).toBe(false);
  // Same machine, a failure that a fresh container does not answer.
  expect(shouldStartLocal(NOBODY, other)).toBe(false);
  expect(shouldStartLocal("not a url", refused)).toBe(false);
});
