import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { jsonOr } from "../../src/contracts/json.ts";

/**
 * A `package.json` script that shells out gets none of `.env`.
 *
 * Bun loads `.env` into its own process, and a script running another Bun
 * process therefore sees it — the child loads it too. A script running
 * anything else does not: measured, `sh -c 'echo ${FOO}'` prints nothing where
 * `bun run probe.ts` prints the value.
 */
/**
 * `bun run db:up` was that, for two releases. `docker/postgres-compose.yml`
 * interpolates `${ORCH_POSTGRES_PASSWORD:?…}`, the password lives in `.env`
 * beside the connection string, and compose never saw it — so the one command
 * the docs give for starting the database failed on every machine that followed
 * them. `local-postgres.ts` was unaffected because it is Bun code passing
 * `{ ...process.env }` explicitly.
 */
const Scripts = z.object({ scripts: z.record(z.string(), z.string()) });

const scripts = (): [string, string][] =>
  Object.entries(jsonOr(readFileSync("package.json", "utf8"), Scripts, { scripts: {} }).scripts);

/** The compose files a script names, for the ones that interpolate anything. */
const interpolating = (command: string): string[] =>
  [...command.matchAll(/-f\s+(\S+compose\S*\.ya?ml)/g)]
    .map((m) => m[1]!)
    .filter((file) => /\$\{[A-Z_]/.test(readFileSync(file, "utf8")));

test("a script that runs docker compose on an interpolating file sources .env first", () => {
  const blind = scripts().flatMap(([name, command]) => {
    if (!command.includes("docker compose") || !interpolating(command).length) return [];
    // Sourced, and guarded so a checkout without `.env` still reaches compose's
    // own `set ORCH_POSTGRES_PASSWORD` rather than `couldn't find env file` —
    // which is what `--env-file` would have produced, measured.
    const sources = /\[ -f \.env \] && \. \.\/\.env/.test(command);
    return sources ? [] : [`${name}: ${command}`];
  });

  expect(blind).toEqual([]);
});

test("the guard can see a script that does not source it", () => {
  // Or the assertion above passes on a repository where nothing runs compose.
  expect(scripts().filter(([, c]) => c.includes("docker compose")).length).toBeGreaterThan(0);
  expect(interpolating("-f docker/postgres-compose.yml")).toEqual(["docker/postgres-compose.yml"]);
  expect(interpolating("-f docker/otel-compose.yml")).toEqual([]);
});
