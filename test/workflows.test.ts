import { describe, expect, test } from "bun:test";
import { z } from "zod";

const workflowNames = ["ci", "codeql", "security", "nightly", "release"] as const;
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

const source = (name: (typeof workflowNames)[number]) => Bun.file(`.github/workflows/${name}.yml`).text();
const load = async (name: (typeof workflowNames)[number]) => WorkflowSchema.parse(Bun.YAML.parse(await source(name)));

function expectUnconditionalSteps(workflow: Workflow, jobName: string, names: readonly string[]): void {
  const steps = workflow.jobs[jobName]!.steps;
  for (const name of names) expect(steps.find((step) => step.name === name)?.if).toBeUndefined();
}

function expectDryRunOnlyJobs(workflow: Workflow, names: readonly string[]): void {
  for (const name of names) expect(workflow.jobs[name]?.if).toBe("${{ !inputs.dry_run }}");
}

describe("workflow governance", () => {
  test("every action is immutable and Bun is exact", async () => {
    for (const name of workflowNames) {
      const workflow = await load(name);
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
          if (step.uses) expect(step.uses, `${name}: ${step.uses}`).toMatch(/^[^@]+@[0-9a-f]{40}$/);
          if (step.uses?.startsWith("oven-sh/setup-bun@"))
            expect(step.with?.["bun-version"]).toBe("${{ env.BUN_VERSION }}");
        }
      }
      expect(await source(name)).not.toMatch(/bun-version:\s*(latest|canary)/);
    }
  });

  test("CI exposes independent read-only required jobs", async () => {
    const ci = await load("ci");
    expect(Object.keys(ci.jobs)).toEqual([
      "quality-format",
      "quality-types",
      "quality-oxlint",
      "quality-fallow",
      "test-main",
      "build-web",
      "dco",
      "pr-plan",
    ]);
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(Object.values(ci.jobs).every((job) => job.permissions === undefined)).toBe(true);
    expect(await source("ci")).not.toMatch(/audit:fix|format --write|git (add|commit|push)|create-github-app-token/);
  });

  test("security tools have one owner each", async () => {
    const codeql = await load("codeql");
    expect(codeql.jobs["security-codeql"]).toBeDefined();

    const security = await load("security");
    expect(Object.keys(security.jobs)).toEqual(["security-dependencies", "security-container", "workflow-static"]);
    const securityText = await source("security");
    expect(securityText).toContain("bun audit");
    expect(securityText).toContain("actions/dependency-review-action@");
    expect(securityText).toContain("aquasecurity/trivy-action@");
    expect(securityText).toContain("actionlint@v1.7.12");
    expect(securityText).toContain("zizmor==1.29.0");

    const all = (await Promise.all(workflowNames.map(source))).join("\n");
    expect(all).not.toMatch(/semgrep|snyk|syft/i);
  });

  test("nightly raises property runs and repeats randomized tests", async () => {
    const nightly = await source("nightly");
    expect(nightly).toContain("FC_NUM_RUNS: '1000'");
    expect(nightly).toContain("bun run test:stress");
    expect(nightly).toContain("bun run perf:bench");
    expect(nightly).toContain("bun run audit");
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

    assertBuildsFirst(ci, "test-main", "bun test --max-concurrency 4");
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
    for (const check of [
      "quality-format",
      "quality-types",
      "quality-oxlint",
      "quality-fallow",
      "test-main",
      "build-web",
      "dco",
      "pr-plan",
      "security-codeql",
      "security-dependencies",
      "security-container",
      "workflow-static",
    ]) {
      expect(checkGate).toContain(check);
    }
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
    const dockerfile = await Bun.file("docker/agent.Dockerfile").text();
    expect(dockerfile).toMatch(/^FROM oven\/bun:1\.3\.5@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile).toContain("ARG CLAUDE_CODE_VERSION=2.1.233");
    expect(dockerfile).toContain("ARG CODEX_VERSION=0.147.0");
    expect(dockerfile).not.toContain("@latest");

    const dependabot = await Bun.file(".github/dependabot.yml").text();
    for (const ecosystem of ["github-actions", "bun", "docker"])
      expect(dependabot).toContain(`package-ecosystem: ${ecosystem}`);
  });
});
