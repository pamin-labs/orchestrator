import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

const workflowNames = ["ci", "codeql", "security", "nightly", "release", "pr-report"] as const;
const StringMap = z.record(z.string(), z.string());
const JsonMap = z.record(z.string(), z.json());
const WorkflowSchema = z.object({
  permissions: StringMap.optional(),
  jobs: z.record(
    z.string(),
    z.object({
      name: z.string().optional(),
      if: z.string().optional(),
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      permissions: StringMap.optional(),
      strategy: z.looseObject({ matrix: JsonMap.optional() }).optional(),
      steps: z.array(
        z.object({
          name: z.string().optional(),
          if: z.string().optional(),
          uses: z.string().optional(),
          run: z.string().optional(),
          with: JsonMap.optional(),
        }),
      ),
    }),
  ),
});
type Workflow = z.infer<typeof WorkflowSchema>;

const CompositeActionSchema = z.object({
  runs: z.object({
    using: z.literal("composite"),
    steps: z.array(
      z.object({
        uses: z.string().optional(),
        run: z.string().optional(),
        with: JsonMap.optional(),
      }),
    ),
  }),
});

const source = (name: (typeof workflowNames)[number]) => Bun.file(`.github/workflows/${name}.yml`).text();
const load = async (name: (typeof workflowNames)[number]) => WorkflowSchema.parse(Bun.YAML.parse(await source(name)));

function expectUnconditionalSteps(workflow: Workflow, jobName: string, names: readonly string[]): void {
  const steps = workflow.jobs[jobName]!.steps;
  for (const name of names) expect(steps.find((step) => step.name === name)?.if).toBeUndefined();
}

function expectDryRunOnlyJobs(workflow: Workflow, names: readonly string[]): void {
  for (const name of names) expect(workflow.jobs[name]?.if).toBe("${{ !inputs.dry_run }}");
}

/**
 * The required-check list, from the file both the release gate and the ruleset
 * are supposed to agree with.
 *
 * Asserting a hardcoded copy here would make this the fourth place the list
 * lives, which is the problem rather than a check on it.
 */
function requiredChecks(): string[] {
  return readFileSync(".github/required-checks.txt", "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("workflow governance", () => {
  test("every action is immutable and Bun is exact", async () => {
    for (const name of workflowNames) {
      const workflow = await load(name);
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
          if (step.uses?.startsWith("./")) {
            expect(step.uses, `${name}: ${step.uses}`).toBe("./.github/actions/setup-bun");
            expect(step.with?.["bun-version"]).toBe("${{ env.BUN_VERSION }}");
          } else if (step.uses) {
            expect(step.uses, `${name}: ${step.uses}`).toMatch(/^[^@]+@[0-9a-f]{40}$/);
          }
        }
      }
      expect(await source(name)).not.toMatch(/bun-version:\s*(latest|canary)/);
    }

    const setup = CompositeActionSchema.parse(
      Bun.YAML.parse(await Bun.file(".github/actions/setup-bun/action.yml").text()),
    );
    expect(setup.runs.steps.find((step) => step.uses)?.uses).toMatch(/^oven-sh\/setup-bun@[0-9a-f]{40}$/);
    expect(setup.runs.steps.find((step) => step.run)?.run).toBe("bun install --frozen-lockfile");
  });

  test("CI exposes independent read-only required jobs", async () => {
    const ci = await load("ci");
    // Three jobs, and the count is the assertion. Actions bills per job rounded
    // up to the minute, so nine jobs totalling 229s cost ten billed minutes —
    // a 4-second `pr-plan` billed a whole one. Splitting these back apart is a
    // cost regression that nothing else would notice.
    expect(Object.keys(ci.jobs)).toEqual(["quality", "test", "pr"]);
    // And every one of them is required. A job that runs but is not in the list
    // is a check nobody has to pass — which is the same shape as the ruleset bug
    // this repository already found, seen from the other side.
    for (const job of Object.keys(ci.jobs)) expect(requiredChecks()).toContain(job);
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(Object.values(ci.jobs).every((job) => job.permissions === undefined)).toBe(true);
    const ciText = await source("ci");
    // `edited` is load-bearing, not decoration. `pr-plan` reads the pull
    // request body out of the event payload, so without this the check that
    // asks for the engineering plan does not re-run when the plan is written —
    // the author has to push an unrelated commit, and until then a satisfied
    // body shows a red gate. Observed twice on the pull request that added it.
    expect(ciText).toContain("types: [opened, synchronize, reopened, edited]");
    expect(ciText).not.toMatch(/audit:fix|format --write|git (add|commit|push)|create-github-app-token/);
    expect(ciText).not.toContain("bun run perf:bench");

    const fallow = ci.jobs["test"]!.steps.find((step) => step.name === "audit repository structure")?.run;
    expect(fallow?.match(/bun run audit/g)).toHaveLength(1);
    expect(fallow).toContain("--format json");
    expect(fallow).toContain("fallow report --from");
    expect(fallow).toContain("--format github-annotations");
    expect(fallow).toContain("--format github-summary");
    expect(fallow).toContain('exit "$audit_status"');
  });

  test("CI only uploads the report evidence a privileged second stage consumes", async () => {
    const ci = await load("ci");
    const ciText = await source("ci");
    const uploads = Object.values(ci.jobs).flatMap((job) =>
      job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@")),
    );

    const uploadNames = uploads.map((step) => step.with?.name).filter((name) => typeof name === "string");
    // Two artifacts, not four, because there are two jobs producing evidence.
    // `pr-report` downloads `report-*` with `merge-multiple`, so what it reads
    // are the *file* names — `junit.xml`, `lcov.info`, `fallow-audit.json`,
    // `budget.txt` — and those are unchanged.
    expect(uploadNames.toSorted((a, b) => a.localeCompare(b))).toEqual(["report-budget", "report-tests"]);
    // A red job still has to hand its evidence over, or the comment reports nothing
    // exactly when the reader needs it most.
    for (const upload of uploads) expect(upload.if).toBe("always()");
    // The JUnit flag moved into `test:coverage:ci` when the test jobs merged —
    // CI supplies the path and the script owns the reporter, so the workflow is
    // asserted on what it still decides. Both halves have to be present or the
    // report comment silently loses its test results.
    expect(ciText).toContain("bun run test:coverage:ci");
    expect(ciText).toContain("JUNIT_OUT");
    // Read as text rather than parsed and asserted: `json()` is `any`, and a
    // cast to make one line of this test typecheck is the sort of assertion the
    // linter refuses everywhere else for good reason.
    const scripts = await Bun.file("package.json").text();
    expect(scripts).toMatch(/"test:coverage:ci":[^\n]*--reporter=junit/);
    expect(ciText).toContain('bun run perf:budget | tee "$RUNNER_TEMP/report/budget.txt"');
    // `workflow_run` carries no pull-request number, so every artifact carries one.
    expect(ciText.match(/report\/pr-number\.txt/g)).toHaveLength(uploads.length);
    expect(ciText).not.toMatch(/sticky-pull-request-comment|codecov/);
  });

  test("the report stage comments with the permissions a fork pull request cannot hold", async () => {
    const report = await load("pr-report");
    const reportText = await source("pr-report");
    const job = report.jobs["pr-report"]!;

    expect(reportText).toContain("workflows: [ci]");
    expect(reportText).toContain("types: [completed]");
    expect(job.if).toBe("github.event.workflow_run.event == 'pull_request'");
    expect(report.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ "pull-requests": "write", actions: "read", "id-token": "write" });

    const download = job.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))!;
    expect(download.with?.["run-id"]).toBe("${{ github.event.workflow_run.id }}");
    expect(download.with?.pattern).toBe("report-*");

    const codecov = job.steps.filter((step) => step.uses?.startsWith("codecov/codecov-action@"));
    expect(codecov).toHaveLength(2);
    for (const step of codecov) {
      expect(step.with?.use_oidc).toBe(true);
      expect(step.with?.override_commit).toBe("${{ github.event.workflow_run.head_sha }}");
      expect(step.with?.override_pr).toBe("${{ steps.pr.outputs.number }}");
    }
    expect(codecov.map((step) => step.with?.report_type)).toEqual([undefined, "test_results"]);
    expect(reportText).not.toContain("CODECOV_TOKEN");

    // One sticky comment updated per commit, and coverage numbers left to Codecov's.
    const sticky = job.steps.find((step) => step.uses?.startsWith("marocchino/sticky-pull-request-comment@"))!;
    expect(sticky.with?.header).toBe("pr-report");
    expect(sticky.with?.number).toBe("${{ steps.pr.outputs.number }}");
    expect(reportText).toContain("cancel-in-progress: true");
    expect(reportText).not.toMatch(/Statements\s*:|coverage percent|Lines\s*:/);
  });

  test("only changed lines can fail the coverage gate", async () => {
    const codecov = z
      .object({
        coverage: z.object({
          status: z.object({
            patch: z.object({ default: z.looseObject({ target: z.string(), informational: z.boolean().optional() }) }),
            project: z.object({ default: z.looseObject({ informational: z.boolean() }) }),
          }),
        }),
        ignore: z.array(z.string()),
      })
      .parse(Bun.YAML.parse(await Bun.file("codecov.yml").text()));

    expect(codecov.coverage.status.patch.default.informational ?? false).toBe(false);
    expect(codecov.coverage.status.patch.default.target).toMatch(/^\d+%$/);
    expect(codecov.coverage.status.project.default.informational).toBe(true);
    expect(codecov.ignore).toContain("test/**");
  });

  test("security tools have one owner each", async () => {
    const codeql = await load("codeql");
    expect(codeql.jobs["security-codeql"]).toBeDefined();

    const security = await load("security");
    expect(Object.keys(security.jobs)).toEqual([
      "security-fallow",
      "security-dependencies",
      "security-container",
      "workflow-static",
    ]);
    const securityText = await source("security");
    const fallow = security.jobs["security-fallow"]!.steps.find(
      (step) => step.name === "scan newly reachable security candidates",
    )?.run;
    expect(fallow?.match(/fallow security/g)).toHaveLength(1);
    expect(fallow).toContain("--gate newly-reachable");
    expect(fallow).toContain("--changed-since");
    expect(fallow).toContain("fallow report --from");
    expect(fallow).toContain("--format github-annotations");
    expect(fallow).toContain("--format github-summary");
    expect(fallow).toContain('exit "$security_status"');
    expect(securityText).toContain("bun audit");
    expect(securityText).toContain("actions/dependency-review-action@");
    expect(securityText).toContain("aquasecurity/trivy-action@");
    expect(securityText).toContain("sha256sum --check");
    expect(securityText).toContain("gh attestation verify");
    expect(securityText).toContain("./actionlint -color");
    expect(securityText).toMatch(/uvx --from zizmor==\d+\.\d+\.\d+ zizmor --pedantic/);
    expect(securityText).not.toMatch(/go install .*actionlint/);

    const all = (await Promise.all(workflowNames.map(source))).join("\n");
    expect(all).not.toMatch(/semgrep|snyk|syft/i);
  });

  test("nightly raises property runs and repeats randomized tests", async () => {
    const nightly = await source("nightly");
    expect(nightly).toContain("FC_NUM_RUNS: '1000'");
    expect(nightly).toContain("bun run test:stress");
    expect(nightly).toContain("bun run perf:bench");
    expect(nightly).toContain("bun run audit");
    expect(nightly).toContain("fallow security --surface");
    expect(nightly).toContain("fallow report --from");
    expect(nightly).toContain("bun audit");
  });

  test("fresh checkout builds the web bundle before full and stress tests", async () => {
    const ci = await load("ci");
    const nightly = await load("nightly");
    const assertBuildsFirst = (workflow: Workflow, jobName: string, testCommand: string) => {
      const steps = workflow.jobs[jobName]!.steps;
      const buildIndex = steps.findIndex((step) => step.run?.includes("bun run build:web"));
      const testIndex = steps.findIndex((step) => step.run?.includes(testCommand));

      expect(buildIndex, `${jobName} must build web`).toBeGreaterThanOrEqual(0);
      expect(testIndex, `${jobName} must run its test command`).toBeGreaterThan(buildIndex);
    };

    // `bun test`, not its flags. The property is the ordering — a suite that runs
    // before the bundle exists tests the previous build — and pinning the flag
    // string meant changing the runner's concurrency broke a guard about order.
    assertBuildsFirst(ci, "test", "bun run test:coverage");
    assertBuildsFirst(nightly, "test-stress", "bun run test:stress");
  });

  test("release accepts only current main with successful named checks", async () => {
    const workflow = await load("release");
    const release = await source("release");
    const checks = workflow.jobs.checks!;
    const sourceSelection = checks.steps.find((step) => step.name === "select immutable main source")?.run ?? "";
    const checkGate = checks.steps.find((step) => step.name === "require successful source checks")?.run ?? "";

    expect(checks.permissions).toEqual({ contents: "read", checks: "read" });
    expect(sourceSelection).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(sourceSelection).toContain('git/ref/heads/main" --jq .object.sha');
    expect(sourceSelection).toContain('test "$sha" = "$main_sha"');
    expect(sourceSelection).toContain("git/ref/tags/v$RELEASE_VERSION");
    expect(sourceSelection).toContain("releases/tags/v$RELEASE_VERSION");
    expect(sourceSelection).toContain("commits/v$RELEASE_VERSION");
    // The gate reads the list rather than restating it, so what is asserted here
    // is the *reading*. Restating the names would put a fourth copy of the list
    // in the place testing that there is only one.
    expect(checkGate).toContain(".github/required-checks.txt");
    expect(checkGate).toContain("required-checks.txt is empty");
    expect(requiredChecks().length).toBeGreaterThan(5);
    expect(checkGate).toContain("commits/$SOURCE_SHA/check-runs?per_page=100");
    expect(checkGate).toContain('"completed:success"');
    expect(release).toContain("ref: ${{ needs.checks.outputs.source-sha }}");
    expect(release).not.toMatch(/bun pm pkg set|audit:fix|git (add|commit|cherry-pick|tag|push)/);
    expect(release).toContain('gh release create "v$RELEASE_VERSION" dist/* --verify-tag');
    expect(release).not.toContain('--target "$SOURCE_SHA"');
  });

  test("release tag creation is atomic and rejects a raced source", async () => {
    const workflow = await load("release");
    const publish = workflow.jobs.publish!;
    const bindIndex = publish.steps.findIndex((step) => step.name === "atomically bind release tag to verified source");
    const releaseIndex = publish.steps.findIndex((step) => step.name === "create release at the verified SHA");
    const bind = publish.steps[bindIndex]?.run ?? "";

    expect(bindIndex).toBe(releaseIndex - 1);
    expect(bind).toContain('gh api --method POST "repos/$GITHUB_REPOSITORY/git/refs"');
    expect(bind).toContain('-f ref="refs/tags/$tag" -f sha="$SOURCE_SHA"');
    expect(bind).toContain('commits/$tag" --jq .sha');
    expect(bind).toContain('test "$existing" = "$SOURCE_SHA"');
    expect(bind).toContain('test "$resolved" = "$SOURCE_SHA"');
  });

  test("release refuses divergent existing image tags", async () => {
    const workflow = await load("release");
    const imagePush = workflow.jobs["image-push"]!;
    const stage =
      imagePush.steps.find((step) => step.name === "push only the image that passed verification")?.run ?? "";
    const manifest =
      workflow.jobs.manifest!.steps.find((step) => step.name === "create multi-platform manifest")?.run ?? "";

    expect(stage).toContain('stage="$IMAGE:sha-$SOURCE_SHA-$PLATFORM"');
    expect(stage).toContain("remote_id=$(jq -r '.config.digest // empty'");
    expect(stage).toContain('test "$remote_id" = "$loaded_id"');
    expect(manifest).toContain('if [ -n "$existing" ] && [ "$existing" != "$expected" ]');
    expect(manifest).toContain("already points to $existing, not verified digest $expected");
    expect(manifest).toContain('promote "$image:$RELEASE_VERSION-$platform"');
    expect(manifest).toContain('promote "$image:$RELEASE_VERSION"');
  });

  test("a partial release rerun reuses only identical staged artifacts", async () => {
    const workflow = await load("release");
    const checks = workflow.jobs.checks!;
    const select = checks.steps.find((step) => step.name === "select immutable main source")?.run ?? "";
    const manifest =
      workflow.jobs.manifest!.steps.find((step) => step.name === "create multi-platform manifest")?.run ?? "";

    expect(select).toContain("is already published and immutable releases are not re-cut");
    expect(select).toContain('test "$tag_sha" = "$sha"');
    expect(select).toContain("resuming the unpublished");
    expect(manifest).toContain('if [ -z "$existing" ]');
    expect(manifest).toContain('test "$(digest_of "$destination")" = "$expected"');
    expect(manifest).toContain('stage_manifest="$image:sha-$SOURCE_SHA"');
    expect(manifest).toContain("exists with divergent platform digests");
  });

  test("dry run builds, loads, scans, and inventories images without publication", async () => {
    const workflow = await load("release");
    const release = await source("release");
    const imageBuild = workflow.jobs["image-build"]!;
    const build = imageBuild.steps.find((step) => step.uses?.startsWith("docker/build-push-action@"))!;

    expect(imageBuild.permissions).toBeUndefined();
    expect(imageBuild.strategy?.matrix?.platform).toEqual(["amd64", "arm64"]);
    expect(build.with?.load).toBe(true);
    expect(build.with?.push).toBe(false);
    expect(build.with?.provenance).toBe("mode=max");
    expectUnconditionalSteps(workflow, "image-build", [
      "verify image digest and provenance material",
      "scan verified image",
      "create verified image SPDX SBOM",
      "create verified image CycloneDX SBOM",
    ]);
    expect(imageBuild.steps.find((step) => step.name === "save verified image for publication")?.if).toBe(
      "${{ !inputs.dry_run }}",
    );
    expectDryRunOnlyJobs(workflow, ["image-push", "manifest", "publish", "promote-latest"]);
    expect(release).toContain('has("buildx.build.provenance")');
    expect(release).toContain("docker image inspect --format '{{.Id}}'");
    expect(release).toContain("trivy-config: trivy.yaml");
  });

  test("release checksums and attests every published artifact", async () => {
    const workflow = await load("release");
    const release = await source("release");
    for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"]) {
      expect(release).toContain(target);
    }
    expect(release).toContain("release-manifest.json");
    expect(release).toContain("bun-linux-x64-baseline");
    expect(release).toContain("bun-windows-x64-baseline");
    expect(release.match(/__ORCH_VERSION__/g)).toHaveLength(2);
    expect(release).toContain('bun "$root/src/orch/cli.ts" --version');
    expect(release).toContain('"$root/orch-server" --version');
    for (const path of [
      "package.json",
      "README.md",
      "LICENSE",
      "src/orch/cli.ts",
      "config/default.yaml",
      "web/dist/main.js",
      "web/dist/app.css",
    ]) {
      expect(release).toContain(path);
    }
    expect(release).toContain("m.bun_target!==process.env.BUN_TARGET");
    expect(release).toContain("/healthz");
    expect(release).toContain("binary exceeds 150 MiB");
    expect(release).toContain("bun run perf:budget");
    expect(release.match(/format: spdx-json/g)?.length).toBeGreaterThanOrEqual(3);
    expect(release.match(/format: cyclonedx/g)?.length).toBeGreaterThanOrEqual(3);
    expect(release).toContain("registry-image-manifest.json");
    expect(release).toContain("image-manifest-${{ matrix.platform }}.json");
    expect(release).toContain("find . -maxdepth 1 -type f ! -name SHA256SUMS -print0");
    expect(release).toContain("sha256sum --check SHA256SUMS");
    expect(release).toContain("subject-path: dist/*");
    expect(release).toContain("actions/attest-build-provenance@");
    expect(release).toContain("actions/attest-sbom@");
    expect(workflow.jobs.publish?.needs).toEqual(["checks", "release-evidence", "manifest"]);
  });

  test("release uses the supported immutable action revisions", async () => {
    const release = await source("release");
    for (const action of [
      "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      "aquasecurity/trivy-action@a9c7b0f06e461e9d4b4d1711f154ee024b8d7ab8",
      "actions/attest-build-provenance@43d14bc2b83dec42d39ecae14e916627a18bb661",
      "actions/attest-sbom@51e74621a501c89df81fc1391c5a8f4cfc9fab2f",
    ]) {
      expect(release).toContain(action);
    }
    expect(release.match(/\.\/\.github\/actions\/setup-bun/g)).toHaveLength(2);
    expect(release).not.toContain("oven-sh/setup-bun@");
  });

  test("latest advances only after the immutable GitHub release exists", async () => {
    const workflow = await load("release");
    const manifest = workflow.jobs.manifest!;
    const publish = workflow.jobs.publish!;
    const latest = workflow.jobs["promote-latest"]!;
    const manifestRun = manifest.steps.find((step) => step.name === "create multi-platform manifest")?.run ?? "";
    const latestRun = latest.steps.find((step) => step.name === "promote the published manifest to latest")?.run ?? "";

    expect(manifestRun).not.toContain('imagetools create -t "$image:latest"');
    expect(publish.steps.at(-1)?.name).toBe("create release at the verified SHA");
    expect(latest.needs).toEqual(["manifest", "publish"]);
    expect(latest.permissions).toEqual({ contents: "read", packages: "write" });
    expect(latestRun).toContain('test "$current" = "$PREVIOUS_LATEST"');
    expect(latestRun).toContain('imagetools create -t "$IMAGE:latest" "$IMAGE@$EXPECTED_DIGEST"');
    expect(latestRun).toContain('test "$(digest_of "$IMAGE:latest")" = "$EXPECTED_DIGEST"');
  });

  test("container and update inputs are pinned", async () => {
    // The risk is drift, not any particular version: the agent container and
    // the jobs that build and test it have to run the same runtime, and a
    // literal here pins one of the six places it is written while the other
    // five move. So the assertion is that they agree, and that the image is
    // still pinned by digest.
    const versions = await Promise.all(
      workflowNames.map(async (name) => /BUN_VERSION:\s*([\d.]+)/.exec(await source(name))?.[1]),
    );
    const declared = versions.filter((v) => v !== undefined);
    expect(declared.length).toBeGreaterThan(0);
    expect([...new Set(declared)]).toHaveLength(1);

    const dockerfile = await Bun.file("docker/agent.Dockerfile").text();
    expect(dockerfile).toMatch(
      new RegExp(`^FROM oven/bun:${declared[0]!.replaceAll(".", "\\.")}@sha256:[0-9a-f]{64}$`, "m"),
    );
    expect(dockerfile).toContain("ARG CLAUDE_CODE_VERSION=2.1.233");
    expect(dockerfile).toContain("ARG CODEX_VERSION=0.147.0");
    expect(dockerfile).not.toContain("@latest");

    const dependabot = await Bun.file(".github/dependabot.yml").text();
    for (const ecosystem of ["github-actions", "bun", "docker"])
      expect(dependabot).toContain(`package-ecosystem: ${ecosystem}`);
  });

  test("every image this repository names is pinned by digest, not by tag", async () => {
    // The assertion above pins one file by name, which only holds until somebody
    // adds a second. A tag is a name its publisher can repoint, so "which image
    // did we actually run" stops being answerable — including for the local
    // trace viewer, which receives every span the server emits.
    const files = [...new Bun.Glob("docker/*").scanSync({ cwd: "." })].toSorted((a, b) => a.localeCompare(b));
    expect(files.length).toBeGreaterThan(1);
    const unpinned: string[] = [];
    for (const path of files) {
      const text = await Bun.file(path).text();
      for (const [index, line] of text.split("\n").entries()) {
        const reference = /^\s*(?:FROM|image:)\s+(\S+)/.exec(line)?.[1];
        if (reference && !/@sha256:[0-9a-f]{64}$/.test(reference)) unpinned.push(`${path}:${index + 1} ${reference}`);
      }
    }
    expect(unpinned).toEqual([]);
  });
});
