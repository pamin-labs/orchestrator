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
 * Not a replacement for CI: four checks have no local form at all, and the end
 * of every run names them. That list lives at the bottom of this file; a copy
 * here would be the second owner, which is the class of defect this whole file
 * was written to close.
 */
import { $ } from "bun";

type Outcome = "pass" | "fail" | "skip";

interface Step {
  name: string;
  /** The CI job this stands in for, so a failure here names the check it will be. */
  job: string;
  run: () => Promise<Outcome | { outcome: Outcome; note: string }>;
}

/**
 * A command's exit status, with its output shown only when it matters.
 *
 * Through bun's `$`, which the rest of this file already uses: the hand-built
 * `Bun.spawn(["sh", "-c", …])` plus two `new Response(...).text()` was a second
 * way to run a command in a file that had one.
 */
async function cmd(line: string): Promise<Outcome> {
  const r = await $`sh -c ${line}`.quiet().nothrow();
  if (r.exitCode === 0) return "pass";
  process.stdout.write(`${r.stdout.toString()}${r.stderr.toString()}`);
  return "fail";
}

/** Whether a binary is on PATH, for the steps that need one we do not ship. */
/** Pinned beside `security.yml`'s copy; a governance test keeps the two equal. */
const ACTIONLINT_VERSION = "1.7.12";
/** Pinned beside `security.yml`'s copy, for the same reason. */
const ZIZMOR_VERSION = "1.29.0";
/** Pinned here and in `security.yml`'s `TRIVY_VERSION`, held equal by
 *  `agent-toolchain.test.ts` — which guarded the other two and not this one. */
const TRIVY_VERSION = "0.74.0";

/** `Bun.which`, which is what the runtime docs point at for exactly this — the
 *  shell-out spawned a process five times a run to answer a lookup. */
const has = (bin: string): boolean => Bun.which(bin) !== null;

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
  // Editing an English `<Trans>` retires its id, so nine catalogs lose that
  // string at once. The step below regenerates and diffs, which a *complete*
  // catalogue satisfies — the rows are gone from it too. This is the gate that
  // says no.
  {
    name: "every message is translated and keeps its placeholders",
    job: "quality",
    run: () => cmd("bun run i18n:validate"),
  },
  /**
   * The catalogues are a current snapshot of the source, and nothing else asks.
   *
   * Nine translations were lost inside this branch: `extract --clean` retired
   * ids that a later edit brought back as `msg` templates, and no gate saw it.
   * `i18n:validate` could not — the catalogue was *complete*, because the rows
   * were gone from it too — and regenerating the README only reads a count.
   */
  /**
   * Writes rather than checks, and the diff is what asks: `lingui extract` has
   * no `--check`, and running it is the only thing that answers the question.
   *
   * `i18n:extract` derives all three — the catalogues, `zh-Hant` from `zh`, and
   * the README's table — because all three are a function of the same source.
   * They were three steps until it was clear that two of them only ever failed
   * when somebody forgot to run a second command.
   */
  {
    name: "catalogues match the source",
    job: "quality",
    run: () => cmd("bun run i18n:check"),
  },
  // `test`, not `quality`: the bundle moved to that job so a PR compiles it once
  // (`ci.yml` says so where it moved it). This line's whole job is to name the
  // check an author will go and look at.
  { name: "web bundle", job: "test", run: () => cmd("bun run build:web") },
  // CI runs this straight after the bundle and preflight did not, so a size
  // regression was red there and green here. The bundle above is its input.
  { name: "size budgets", job: "test", run: () => cmd("bun run perf:budget") },
  // One suite run, instrumented. There were two — `bun run test` and then
  // `audit:crap`, which runs it again under `ORCH_COVERAGE=1` — on the grounds
  // that the wrapper retries an arm64 worker panic. Both go through
  // `scripts/test.ts`, so both have that; and the instrumented one is the
  // stricter of the two (`test/support/loader.ts` records 21 panel files that
  // fail only under coverage, "so a green `bun run test` says nothing about
  // it"). CI runs `test:coverage:ci` and nothing else, so the plain pass was
  // forty seconds of a hundred-and-seventeen answering about a gate that does
  // not exist.
  //
  // The audit reads CRAP from the coverage map, so the coverage run has to
  // happen first — `audit:crap` is the pair, and running plain `audit` here
  // would repeat the mistake CI made for weeks.
  { name: "coverage + audit", job: "test", run: () => cmd("bun run audit:crap") },
  // CI fails if a step rewrote the tree (`ci.yml`'s `git diff --exit-code`), and
  // preflight did not — so a formatter or a generator writing outside
  // `locales/` and the READMEs was red there and green here. `i18n:check` covers
  // only those three paths.
  {
    name: "nothing was rewritten",
    job: "quality",
    run: () => cmd("git diff --exit-code --stat"),
  },
  {
    name: "security candidates",
    job: "security-fallow",
    // `origin/main`, which is what CI diffs against — a local `main` can sit
    // behind it, and then this answers about a range nobody chose. `signOff`
    // above already had it right.
    run: () => cmd("bunx fallow security --changed-since origin/main --gate newly-reachable --quiet"),
  },
  {
    name: "dependency advisories",
    job: "security-dependencies",
    // Bare, as CI runs it and as the enforcement matrix names it. With
    // `--audit-level=high` a moderate advisory passed here and failed there,
    // which is the divergence that costs a round trip.
    run: () => cmd("bun audit"),
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
      if (has("actionlint") && has("shellcheck")) return cmd("actionlint");
      // Otherwise the pinned image, which this project can assume: a container
      // runtime is already a hard requirement — the agents run in one. It also
      // carries shellcheck and pyflakes, so the shell rules actually run; a bare
      // `actionlint` binary skips them without saying so.
      //
      // Same version as `security.yml` pins, and that is the point of the
      // constant: two places asserting different versions is worse than one
      // place asserting none.
      if (has("docker")) {
        return cmd(
          `docker run --rm -v "${process.cwd()}":/repo -w /repo rhysd/actionlint:${ACTIONLINT_VERSION} -color`,
        );
      }
      return { outcome: "skip", note: "no actionlint and no docker — CI runs it" };
    },
  },
  {
    name: "workflow security",
    job: "workflow-static",
    run: async () => {
      // The other half of that job, and the enforcement matrix names zizmor as
      // its owner — preflight ran actionlint alone and understated a job it
      // claims to stand in for. Measured at 0.04s against this repository, and
      // a workflow edit is both the likeliest thing to trip `--pedantic` and
      // the one edit preflight could not see.
      if (has("uvx")) return cmd(`uvx --from zizmor==${ZIZMOR_VERSION} zizmor --pedantic .github/workflows`);
      return { outcome: "skip", note: "no uvx — CI runs zizmor" };
    },
  },
  {
    // CI's `scan repository` — `scan-type: fs` against `trivy.yaml`, whose
    // `scanners` are vuln, secret and misconfig. Preflight scanned the built
    // image only, so a hardcoded secret or a Dockerfile misconfiguration was
    // caught there and not here, which is the failure this file's header says it
    // exists to prevent.
    name: "repository scan",
    job: "security-container",
    run: async () => {
      if (!has("docker")) return { outcome: "skip" as const, note: "docker not on PATH — CI scans the tree" };
      return cmd(
        `docker run --rm -v "$HOME/.cache/trivy:/root/.cache" -v "$PWD:/work" -w /work ` +
          `aquasec/trivy:${TRIVY_VERSION} fs --quiet --exit-code 1 --config trivy.yaml .`,
      );
    },
  },
  {
    name: "container scan",
    job: "security-container",
    run: async () => {
      if (!has("docker")) return { outcome: "skip", note: "docker not on PATH — CI builds and scans the image" };
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
          `aquasec/trivy:${TRIVY_VERSION} image --quiet --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed ` +
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
console.log(
  "Never local: security-codeql (GitHub infrastructure), " +
    "dependency-review (GitHub's API over the PR's range), " +
    "codecov/patch (posted after CI reports, by a second workflow), " +
    "pr / verify engineering plan sections (reads a pull request body).",
);

if (failed.length > 0) {
  console.log(`\n${failed.length} failed: ${failed.map((r) => r.step.job).join(", ")}`);
  process.exit(1);
}
console.log("\nEverything runnable here passed.");
