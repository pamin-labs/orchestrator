import { expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../../src/platform/process/version.ts";
import { tempDir } from "../support/temp.ts";

test("package.json is the development version source", async () => {
  const metadata: unknown = await Bun.file("package.json").json();
  expect(metadata).toEqual(expect.objectContaining({ version: VERSION }));
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
 * Three comments promise a deletion at 0.2.0 and nothing enforces it.
 *
 * `ALIAS` in `src/mech/util/validate.ts` accepts the six Chinese DRAFT headings
 * a card filed before the keys became ASCII still carries; `draftLegacy` parses
 * the pre-Markdown form; `GOAL_KEY`/`GOAL_INLINE` in `web/src/shared/prose.ts`
 * match both spellings for the panel. All three are correct today — a stored
 * card has to keep parsing — and all three say "retire in 0.2.0" in prose that
 * no command reads. A date written only in a comment is a date nobody meets.
 */
test("the 0.2.0 compatibility shims are still inside their window", () => {
  const [major = "0", minor = "0"] = VERSION.split(".");
  const due = Number(major) > 0 || Number(minor) >= 2;
  const alive = [
    ["src/mech/util/validate.ts", "const ALIAS"],
    ["src/mech/util/validate.ts", "function draftLegacy"],
    ["web/src/shared/prose.ts", "const GOAL_KEY"],
  ].filter(([file, marker]) => readFileSync(file!, "utf8").includes(marker!));

  // Before 0.2.0 they must all still be here: dropping one early is what makes a
  // card in the queue unapprovable.
  if (!due) expect(alive).toHaveLength(3);
  // At 0.2.0 they go, and this is the line that says so out loud.
  else expect(alive).toEqual([]);
});
