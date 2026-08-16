import { describe, expect, test } from "bun:test";
import { z } from "zod";

const Scalar = z.union([z.string(), z.number(), z.boolean()]);
const Step = z.object({
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), Scalar).optional(),
});
const Job = z.object({
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  outputs: z.record(z.string(), Scalar).optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  strategy: z.object({ matrix: z.record(z.string(), z.array(z.string())) }).optional(),
  steps: z.array(Step),
});
const Workflow = z.object({
  permissions: z.record(z.string(), z.string()),
  jobs: z.record(z.string(), Job),
});

const load = async (name: string) =>
  Workflow.parse(Bun.YAML.parse(await Bun.file(`.github/workflows/${name}.yml`).text()));

const named = (job: z.infer<typeof Job>, name: string) => {
  const result = job.steps.find((step) => step.name === name);
  expect(result, `${name} step`).toBeDefined();
  return result!;
};

describe("quality workflows", () => {
  test.each([
    ["ci", "check"],
    ["release", "checks"],
  ] as const)("%s fixes, audits, validates, then lets the App bot push", async (name, jobName) => {
    const workflow = await load(name);
    const job = workflow.jobs[jobName]!;
    const names = job.steps.map((step) => step.name ?? "");
    const fix = names.indexOf("apply safe Fallow fixes and format");
    const audit = job.steps.findIndex((step) => step.uses === "fallow-rs/fallow@v3");
    const validate = job.steps.findIndex((step) => step.run === "bun run validate");
    const token = job.steps.findIndex((step) => step.uses === "actions/create-github-app-token@v3");
    const commit = names.findIndex((step) => step.startsWith("commit "));
    const cleanup = job.steps[fix]!.run!;
    const push = job.steps[commit]!.run!;

    expect(cleanup).toContain("bun run audit:fix");
    expect(cleanup).toContain("git restore --source=HEAD -- .fallowrc.json .fallow/.gitignore");
    expect(cleanup).toContain("bun run format");
    const fixCommand = cleanup.indexOf("bun run audit:fix");
    const restorePolicy = cleanup.indexOf("git restore --source=HEAD");
    const formatCommand = cleanup.indexOf("bun run format");
    expect(fixCommand).toBeLessThan(restorePolicy);
    expect(restorePolicy).toBeLessThan(formatCommand);
    expect(fix).toBeLessThan(audit);
    expect(audit).toBeLessThan(validate);
    expect(validate).toBeLessThan(token);
    expect(token).toBeLessThan(commit);
    expect(push).toContain("orchestrator-agentic-app[bot]");
    expect(push).toContain("git add --all");
    expect(push).toContain("git commit --no-verify -s");
    expect(push).toContain("git push --no-verify");
  });

  test("the Action wrapper follows v3 while package.json pins the scanner", async () => {
    const manifest = z
      .object({ devDependencies: z.object({ fallow: z.string().regex(/^\d+\.\d+\.\d+$/) }) })
      .parse(await Bun.file("package.json").json());
    expect(manifest.devDependencies.fallow).toBe("3.16.0");

    const ci = await load("ci");
    const audit = ci.jobs.check!.steps.find((step) => step.uses === "fallow-rs/fallow@v3")!;
    expect(audit.with?.command).toBe("audit");
    expect(audit.with?.comment).toBe("${{ github.event_name == 'pull_request' }}");
  });

  test("write permissions are limited to the jobs that need them", async () => {
    const ci = await load("ci");
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(ci.jobs.check!.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      "pull-requests": "write",
      checks: "write",
    });
    expect(ci.jobs.dco!.permissions).toBeUndefined();

    const release = await load("release");
    expect(release.permissions).toEqual({ contents: "read" });
    for (const name of ["build", "manifest"] as const) {
      expect(release.jobs[name]!.permissions).toEqual({ contents: "read", packages: "write" });
    }
  });

  test("release makes one cleanup and version commit before selecting its SHA", async () => {
    const { jobs } = await load("release");
    const names = jobs.checks!.steps.map((step) => step.name ?? "");
    const fix = names.indexOf("apply safe Fallow fixes and format");
    const version = names.indexOf("set the version");
    const commit = names.indexOf("commit release changes");
    const source = names.indexOf("select the source commit");

    expect(fix).toBeLessThan(version);
    expect(version).toBeLessThan(commit);
    expect(commit).toBeLessThan(source);
    expect(named(jobs.checks!, "commit release changes").run).toContain(
      'git commit --no-verify -s -m "chore(release): ${RELEASE_VERSION}"',
    );
    expect(named(jobs.checks!, "select the source commit").run).toContain("git rev-parse HEAD");
    expect(jobs.checks!.outputs?.["source-sha"]).toBe("${{ steps.source.outputs.sha }}");
  });

  test("release artifacts use the bot commit and fan out in parallel", async () => {
    const { jobs } = await load("release");
    const sourceRef = "${{ needs.checks.outputs.source-sha }}";

    for (const name of ["binaries", "build"] as const) {
      expect(jobs[name]!.needs).toBe("checks");
      expect(jobs[name]!.steps.find((step) => step.uses?.startsWith("actions/checkout"))?.with?.ref).toBe(sourceRef);
    }
    expect(jobs.publish!.needs).toEqual(["manifest", "binaries", "checks"]);
    expect(jobs.publish!.steps.find((step) => step.uses?.startsWith("actions/checkout"))?.with?.ref).toBe(sourceRef);
  });

  test("release image and platform axes own every image artifact path", async () => {
    const { jobs } = await load("release");
    expect(jobs.build!.strategy!.matrix).toMatchObject({
      image: ["orch-agent"],
      platform: ["amd64", "arm64"],
    });
    expect(jobs.manifest!.strategy!.matrix).toMatchObject({ image: ["orch-agent"] });

    const build = jobs.build!.steps.find((step) => step.uses === "docker/build-push-action@v7")!;
    expect(build.with?.platforms).toBe("linux/${{ matrix.platform }}");
    expect(build.with?.outputs).toContain("/${{ matrix.image }}");
    expect(build.with?.["cache-from"]).toContain("${{ matrix.image }}-${{ matrix.platform }}");
    expect(named(jobs.build!, "hand the digest on").run).toContain("${DIGEST#sha256:}");
    expect(jobs.build!.steps.find((step) => step.uses === "actions/upload-artifact@v7")?.with?.name).toBe(
      "digests-${{ matrix.image }}-${{ matrix.platform }}",
    );

    const download = jobs.manifest!.steps.find((step) => step.uses === "actions/download-artifact@v8")!;
    expect(download.with?.pattern).toBe("digests-${{ matrix.image }}-*");
    const join = named(jobs.manifest!, "join them").run!;
    expect(join).toContain("/${{ matrix.image }}:$RELEASE_VERSION");
    expect(join).toContain("/${{ matrix.image }}@sha256:");
  });
});
