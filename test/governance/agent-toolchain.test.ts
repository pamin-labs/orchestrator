import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../src/platform/config/load.ts";

/**
 * A tool a prompt tells an agent to run has to exist in the image it runs in.
 *
 * These are two files nobody edits together: the instructions live in
 * `prompt/assemble.ts` and the roles, and the toolchain lives in a Dockerfile.
 * An agent that runs `rg` in an image without it does not fail usefully — it gets
 * `command not found`, burns the turn, and the transcript reads as the model
 * being confused rather than as a missing package.
 *
 * Only the names worth the check: `git` and `rg` are the two the prompts name as
 * commands to type. Shell builtins and `orch` itself are not packages.
 */
const CHECKED = ["rg", "git"] as const;

/**
 * Instructions only — comments stripped.
 *
 * The first version of this matched the whole file, and the comment explaining
 * *why* ripgrep is installed contains the word "ripgrep". Deleting it from the
 * `apt-get` line left the test green, which is the failure mode the rule about
 * showing a guard fail exists to catch, found by doing exactly that.
 */
const dockerfile = (): string =>
  readFileSync(join(ROOT, "docker/agent.Dockerfile"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

function promptText(): string {
  const roles = join(ROOT, "roles");
  const files = readdirSync(roles)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => readFileSync(join(roles, f), "utf8"));
  return [readFileSync(join(ROOT, "src/prompt/assemble.ts"), "utf8"), ...files].join("\n");
}

test("every command the prompts tell an agent to run is installed in the agent image", () => {
  const text = promptText();
  const image = dockerfile();
  const named = CHECKED.filter((tool) => new RegExp(`\\b${tool}\\b`).test(text));
  // Non-empty, or the loop below would pass by finding nothing to check.
  expect(named.length).toBeGreaterThan(0);
  // `ripgrep` is the package; `rg` is the command. Named explicitly rather than
  // guessed, because the two differing is exactly the kind of thing that makes a
  // string search agree with itself and disagree with the image.
  const packageOf: Record<string, string> = { rg: "ripgrep", git: "git" };
  const missing = named.filter((tool) => !new RegExp(`\\b${packageOf[tool]}\\b`).test(image));
  expect(missing).toEqual([]);
});

/**
 * And the reason it is `rg` rather than `grep`, kept as an assertion so that
 * putting `grep` back is a decision somebody makes rather than a word that drifts
 * in. GNU grep does not read `.gitignore`, so a search descends into
 * `node_modules` — and tool results are 90% of a transcript.
 */
test("the prompts do not send an agent to a search that ignores .gitignore", () => {
  const offending = promptText()
    .split("\n")
    .filter((line) => /\bgrep\b/.test(line) && !/--grep|orch lease log/.test(line));
  expect(offending).toEqual([]);
});

/**
 * `preflight` and CI check the workflows with the same actionlint.
 *
 * The local check used to need `brew install actionlint shellcheck`, which is a
 * check that silently does not run for whoever skipped it — and it looks green,
 * because a skipped step is not a failed one. It runs from the pinned image now,
 * which this project can assume: a container runtime is already required, since
 * the agents live in one.
 *
 * Two files naming the version is the cost of that, so this is the guard: a
 * bumped CI pin and a stale local one would mean contributors and CI disagree
 * about what a valid workflow is, which is exactly the disagreement running it
 * locally exists to prevent.
 */
test("the actionlint version preflight runs is the one CI runs", () => {
  const pinned = (text: string, re: RegExp): string | null => re.exec(text)?.[1] ?? null;
  const ci = pinned(
    readFileSync(join(ROOT, ".github/workflows/security.yml"), "utf8"),
    /ACTIONLINT_VERSION:\s*([\d.]+)/,
  );
  const local = pinned(readFileSync(join(ROOT, "scripts/preflight.ts"), "utf8"), /ACTIONLINT_VERSION = "([\d.]+)"/);
  expect(local).not.toBeNull();
  expect(local).toBe(ci);
});
