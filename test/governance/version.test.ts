import { expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { VERSION } from "../../src/platform/process/version.ts";
import { tempDir } from "../support/temp.ts";

test("package.json is the development version source", async () => {
  const metadata: unknown = await Bun.file("package.json").json();
  expect(metadata).toEqual(expect.objectContaining({ version: VERSION }));
});

/**
 * The two version fields below are read from a parsed manifest rather than
 * grepped, because a range and a pin are different answers to "what version" and
 * a regex over the file cannot tell them apart.
 */
const Manifest = z.object({
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
});
const manifest = () => {
  const raw: unknown = JSON.parse(readFileSync("package.json", "utf8"));
  return Manifest.parse(raw);
};

/**
 * drizzle-orm and drizzle-kit are one release named twice: the kit writes the
 * migration format the ORM reads, so a mismatched pair is a schema the running
 * server does not understand.
 */
/**
 * Dependabot resolves each package alone, and drizzle publishes branch snapshots
 * to npm under dist-tags of their own: `rc5` was `1.0.0-rc.5-169397b` for the ORM
 * and `1.0.0-rc.5-ab785fc` for the kit, two commits, both ahead of the `rc` tag
 * still pointing at `1.0.0-rc.4`. PR #12 proposed exactly that pair, and nothing
 * here would have caught it. `.github/dependabot.yml` ignores both; this is the
 * half that holds when somebody bumps one by hand instead.
 */
test("drizzle-orm and drizzle-kit name one release", () => {
  const { dependencies, devDependencies } = manifest();
  // Exact, not a range: a caret over a prerelease channel is how the snapshot
  // arrives without anyone choosing it.
  expect(dependencies["drizzle-orm"]).toMatch(/^\d+\.\d+\.\d+/);
  expect(devDependencies["drizzle-kit"]).toBe(dependencies["drizzle-orm"]);
});

const WORKFLOW_PIN = /^\s*BUN_VERSION:\s*(\S+)$/m;
const IMAGE_PIN = /oven\/bun:(\S+?)@sha256:/;
const versionIn = (file: string, pin: RegExp) => readFileSync(file, "utf8").match(pin)?.slice(1) ?? [];

/**
 * Five files name the Bun this project runs, and one of them used to name
 * whatever npm had published that morning.
 */
/**
 * `@types/bun` was `"latest"`, while Bun is 1.3.14 in four `BUN_VERSION` pins and
 * by digest in the agent image. So the types were the only thing free to move,
 * and they moved to 1.4.0, whose `Response` grew `textStream()`. Hono's
 * `ClientResponse` has no such method, so a lockfile refresh that touched no
 * source produced 81 type errors across nineteen panel files, every one about a
 * method nothing here calls.
 */
/**
 * `workflows.test.ts` refuses `bun-version: latest` in a workflow for the same
 * reason. This is that rule reaching the file it could not see.
 */
test("@types/bun names the bun the workflows and the agent image run", () => {
  const declared = manifest().devDependencies["@types/bun"];
  const pinned = [
    ...readdirSync(".github/workflows").flatMap((file) => versionIn(join(".github/workflows", file), WORKFLOW_PIN)),
    ...versionIn("docker/agent.Dockerfile", IMAGE_PIN),
  ];
  // Four workflows and the image. Asserted, because a scan that matches nothing
  // agrees with everything.
  expect(pinned.length).toBeGreaterThanOrEqual(5);
  expect([...new Set([declared, ...pinned])]).toEqual([declared]);
});

test.each([
  ["orch-server", "src/composition/server.ts"],
  ["orch", "src/orch/cli.ts"],
])("%s reports the package version", async (_name, entrypoint) => {
  const child = Bun.spawn([process.execPath, entrypoint, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe(`${VERSION}\n`);
  expect(await new Response(child.stderr).text()).toBe("");
});

/**
 * The agent's CLI holds no Lingui macro, and there are two layers saying so.
 *
 * `agentCli()` builds `src/orch/cli.ts` with `Bun.build` at **runtime**, to put
 * an `orch` inside every container, and it cannot pass the macro plugin —
 * `src/mech` may not import `scripts/`. So an unexpanded macro throws in the
 * container, hours from anyone reading a build log.
 */
/**
 * The first layer is `.fallowrc.json`: the `cli` zone may import only `cli`,
 * `build-info` and `shared-contracts`, none of which hold a message. That stops
 * a macro arriving through an import, and not one written here — which is what
 * this scan is for. The test below is the third and loudest layer, because it
 * runs the bundle, but it only catches a macro at module scope.
 */
test("no macro reaches the CLI the sandbox builds without a plugin", () => {
  const held = readdirSync(`${process.cwd()}/src/orch`)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => readFileSync(`${process.cwd()}/src/orch/${file}`, "utf8").includes("@lingui/"));
  expect(held).toEqual([]);
});

test("the CLI bundle runs where there is no package.json to read", async () => {
  // The shape a sandbox gets: one bundled file at `/opt/orch/cli.ts`, and no
  // checkout under it. `VERSION` used to be computed by reading package.json from
  // module scope, so this died at import with `ENOENT: /package.json` — taking
  // every `orch` verb the agent has with it, before any of them parsed an argument.
  const { agentCli } = await import("../../src/mech/sandbox/sandbox.ts");
  const dir = tempDir("orch-cli-bundle-");
  try {
    const bundle = join(dir, "cli.ts");
    await Bun.write(bundle, await agentCli());
    const child = Bun.spawn([process.execPath, "run", bundle, "--version"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ code: await child.exited, err: await new Response(child.stderr).text() }).toEqual({ code: 0, err: "" });
    expect((await new Response(child.stdout).text()).trim()).toBe("0.0.0+unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

/**
 * One owner for which *spelling* names which section of a card.
 *
 * There were two: `validateDraftCard` parsed a filed card, and the panel matched
 * the goal heading with a regex of its own on the far side of the `web/src`
 * boundary. They had already disagreed once — `startsWith` against a Markdown
 * card whose first line is a heading, so every card in the queue read
 * `Plan card not submitted` with the card sitting right there.
 */
/** The six Chinese headings are the vocabulary and belong to
 *  `src/contracts/card.ts` alone. A reader naming the field it wants —
 *  `fieldOf(x) === "goal"` — spells nothing: that is a `Field`, and the compiler
 *  owns it. What this refuses is a second table of spellings. */
/** Code, not comments: the comments in these files name the words on purpose,
 *  which is why this strips comment lines rather than grepping the file — the
 *  trap `output-language-is-resolved` recorded, where a comment failed a build. */
/** `ALIAS` is gone, so the contract no longer maps these words either — which is
 *  what makes this guard matter more, not less. A reader that grew its own
 *  `目标` regex now accepts a heading `validateDraftCard` refuses outright, and
 *  that split is the defect the comment above records. */
test("no reader maps a Chinese heading to a card section", () => {
  const aliases = ["目标", "不做", "验收", "切片", "风险", "反对"];
  const readers = ["src/mech/util/validate.ts", "web/src/shared/prose.ts", "src/api/panel/snapshot.ts"];
  const spelled = readers.flatMap((file) => {
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    return aliases.filter((word) => code.includes(word)).map((word) => `${file}: ${word}`);
  });
  expect(spelled).toEqual([]);
});
