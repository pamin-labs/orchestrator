#!/usr/bin/env bun
/**
 * Everything CI will check, run here first.
 *
 * CI minutes are money and a red check costs a round trip, so a pull request
 * should open already knowing the answer. That needs one command, and it needs
 * that command to be honest about what it could not run: a preflight that quietly
 * skips the container scan is worse than none, because it promises a green run it
 * never tested.
 */
/**
 * So every step reports passed, failed, or **skipped with the reason**, and the
 * exit code is non-zero only if something failed. Steps needing a binary this
 * repository does not vendor say so and name what CI will do instead.
 *
 * Not a replacement for CI: `security-codeql` runs on GitHub's infrastructure, and
 * `pr-plan` reads a pull request body that does not exist yet. Both are named at
 * the end of every run.
 */
import { $ } from "bun";

type Outcome = "pass" | "fail" | "skip";

interface Step {
  name: string;
  /** The CI job this stands in for, so a failure here names the check it will be. */
  job: string;
  run: () => Promise<Outcome | { outcome: Outcome; note: string }>;
}

/** A command's exit status, with its output shown only when it matters. */
async function cmd(line: string): Promise<Outcome> {
  const proc = Bun.spawn(["sh", "-c", line], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) {
    process.stdout.write(`${out}${err}`);
    return "fail";
  }
  return "pass";
}

/** Whether a binary is on PATH, for the steps that need one we do not ship. */
/** Pinned beside `security.yml`'s copy; a governance test keeps the two equal. */
const ACTIONLINT_VERSION = "1.7.12";

const has = async (bin: string): Promise<boolean> => (await $`command -v ${bin}`.quiet().nothrow()).exitCode === 0;

/**
 * Commits on this branch whose sign-off does not match their author.
 *
 * Separate from the step that reports it because `dco` compares one trailer per
 * commit and the reporting is four lines of console — together they are one
 * function over the threshold for no reason a reader would recognise.
 */
async function unsigned(): Promise<string[]> {
  const shas = (await $`git rev-list --no-merges origin/main..HEAD`.text()).trim().split("\n").filter(Boolean);
  const missing: string[] = [];
  for (const sha of shas) {
    // Each commit's own author, which is what `dco` compares. Read from
    // `git config` instead, this reported every commit somebody else wrote as
    // unsigned the moment a branch carried one — and the fix it printed,
    // `rebase --signoff`, would have put this machine's name on their work.
    const author = (await $`git log -1 --format=${"%an <%ae>"} ${sha}`.text()).trim();
    if (author.endsWith("[bot]@users.noreply.github.com>")) continue;
    const body = await $`git log -1 --format=%B ${sha}`.text();
    if (!body.toLowerCase().includes(`signed-off-by: ${author}`.toLowerCase())) missing.push(sha.slice(0, 9));
  }
  return missing;
}

async function signOff(): Promise<Outcome> {
  const missing = await unsigned();
  if (missing.length === 0) return "pass";
  console.log(`  ${missing.length} commit(s) without a matching sign-off: ${missing.slice(0, 5).join(" ")}`);
  console.log("  fix: git rebase --signoff origin/main   (rewrites history — force-push after)");
  return "fail";
}

const steps: Step[] = [
  { name: "format", job: "quality", run: () => cmd("bun run format:check") },
  { name: "types", job: "quality", run: () => cmd("bun run typecheck") },
  { name: "lint", job: "quality", run: () => cmd("bun run lint") },
  // Checks rather than writes, so it cannot be the thing that dirties the tree
  // the CI step below it exists to catch.
  { name: "translation table", job: "quality", run: () => cmd("bun run i18n:progress --check") },
  // Nothing else reads a translation: we do not run `lingui compile`, and
  // `compile --strict` also fails on a missing one, which eight locales
  // deliberately are. Named for both halves because it checks both: a message
  // that parses can still have dropped the one number it was written to carry.
  { name: "translations parse and keep their names", job: "quality", run: () => cmd("bun run i18n:validate") },
  { name: "web bundle", job: "quality", run: () => cmd("bun run build:web") },
  // Through `bun run test`, not `bun test` directly: that wrapper retries an arm64
  // worker panic once and nothing else, and this is the command a developer runs
  // before every commit on the machine where that panic happens. CI keeps calling
  // `bun test` — it is x64, cannot hit it, and a retry there would only hide.
  { name: "tests", job: "test", run: () => cmd("bun run test") },
  // The audit reads CRAP from the coverage map, so the coverage run has to
  // happen first — `audit:crap` is the pair, and running plain `audit` here
  // would repeat the mistake CI made for weeks.
  { name: "coverage + audit", job: "test", run: () => cmd("bun run audit:crap") },
  {
    name: "security candidates",
    job: "security-fallow",
    run: () => cmd("bunx fallow security --changed-since main --gate newly-reachable --quiet"),
  },
  {
    name: "dependency advisories",
    job: "security-dependencies",
    run: () => cmd("bun audit --audit-level=high"),
  },
  { name: "sign-off", job: "pr", run: signOff },
  {
    name: "workflow syntax",
    job: "workflow-static",
    run: async () => {
      // A host install is used when it is there, and it is nobody's requirement.
      // Asking a contributor to `brew install` is a check that silently does not
      // run for whoever skipped it — which is the same failure as not having the
      // check, except it looks green.
      if ((await has("actionlint")) && (await has("shellcheck"))) return cmd("actionlint");
      // Otherwise the pinned image, which this project can assume: a container
      // runtime is already a hard requirement — the agents run in one. It also
      // carries shellcheck and pyflakes, so the shell rules actually run; a bare
      // `actionlint` binary skips them without saying so.
      //
      // Same version as `security.yml` pins, and that is the point of the
      // constant: two places asserting different versions is worse than one
      // place asserting none.
      if (await has("docker")) {
        return cmd(
          `docker run --rm -v "${process.cwd()}":/repo -w /repo rhysd/actionlint:${ACTIONLINT_VERSION} -color`,
        );
      }
      return { outcome: "skip", note: "no actionlint and no docker — CI runs it" };
    },
  },
  {
    name: "container scan",
    job: "security-container",
    run: async () => {
      if (!(await has("docker")))
        return { outcome: "skip", note: "docker not on PATH — CI builds and scans the image" };
      const built = await cmd(
        // `--platform linux/amd64`, because that is what CI builds. A preflight
        // that scans a different image than the gate answers confidently about
        // the wrong thing. Known gap recorded in `docs/project/progress.md`:
        // the arm64 build of this image currently fails, so a developer on
        // Apple silicon is testing the CI image rather than one they could run.
        "docker build --quiet --platform linux/amd64 --tag orchestrator-agent:preflight " +
          "--file docker/agent.Dockerfile .",
      );
      if (built !== "pass") return "fail";
      return cmd(
        // The repository is mounted because `trivy.yaml` and `.trivyignore.yaml`
        // live in it: CI runs Trivy on the runner where those are simply there,
        // and running it in a container without them scans at a different policy
        // than the gate does.
        'docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$HOME/.cache/trivy:/root/.cache" ' +
          '-v "$PWD:/work" -w /work ' +
          "aquasec/trivy:0.74.0 image --quiet --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed " +
          "--ignorefile .trivyignore.yaml orchestrator-agent:preflight",
      );
    },
  },
];

const results: { step: Step; outcome: Outcome; note?: string; ms: number }[] = [];
for (const step of steps) {
  const started = performance.now();
  const answer = await step.run();
  const ms = performance.now() - started;
  const outcome = typeof answer === "string" ? answer : answer.outcome;
  const note = typeof answer === "string" ? undefined : answer.note;
  const mark = outcome === "pass" ? "✓" : outcome === "fail" ? "✗" : "–";
  console.log(`${mark} ${step.name.padEnd(22)} ${(ms / 1000).toFixed(1).padStart(5)}s  ${note ?? step.job}`);
  results.push({ step, outcome, ...(note === undefined ? {} : { note }), ms });
}

const failed = results.filter((r) => r.outcome === "fail");
const skipped = results.filter((r) => r.outcome === "skip");
const total = results.reduce((sum, r) => sum + r.ms, 0);

console.log(`\n${(total / 1000).toFixed(1)}s total`);
if (skipped.length > 0) console.log(`${skipped.length} skipped — CI will run them.`);
console.log("Never local: security-codeql (GitHub infrastructure), pr-plan (needs a pull request body).");

if (failed.length > 0) {
  console.log(`\n${failed.length} failed: ${failed.map((r) => r.step.job).join(", ")}`);
  process.exit(1);
}
console.log("\nEverything runnable here passed.");
