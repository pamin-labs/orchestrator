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
