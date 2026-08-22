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
 * Two comments promise a deletion at 0.2.0 and nothing enforces it.
 *
 * `ALIAS` in `src/contracts/card.ts` accepts the six Chinese DRAFT headings a
 * card filed before the keys became ASCII still carries; `draftLegacy` in
 * `src/mech/util/validate.ts` parses the pre-Markdown form. Both are correct
 * today — a stored card has to keep parsing — and both say "retire in 0.2.0" in
 * prose that no command reads. A date written only in a comment is a date
 * nobody meets.
 */
/**
 * It said three, and the third was `GOAL_KEY` in `web/src/shared/prose.ts` — the
 * panel's own `(goal|目标)` regex. That was the shim being kept in two places on
 * opposite sides of a boundary, so the retirement was three deletions somebody
 * had to find. The vocabulary moved into contracts and the panel asks `fieldOf`,
 * which is why this list is two rows now and why the guard below exists.
 */
test("the 0.2.0 compatibility shims are still inside their window", () => {
  const [major = "0", minor = "0"] = VERSION.split(".");
  const due = Number(major) > 0 || Number(minor) >= 2;
  const alive = [
    ["src/contracts/card.ts", "const ALIAS"],
    ["src/mech/util/validate.ts", "function draftLegacy"],
  ].filter(([file, marker]) => readFileSync(file!, "utf8").includes(marker!));

  // Before 0.2.0 they must all still be here: dropping one early is what makes a
  // card in the queue unapprovable.
  if (!due) expect(alive).toHaveLength(2);
  // At 0.2.0 they go, and this is the line that says so out loud.
  else expect(alive).toEqual([]);
});

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
test("nothing but the contract maps a Chinese heading to a card section", () => {
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

  // And the one file that may hold them, holds all six — so this cannot pass by
  // the vocabulary having quietly gone away.
  const contract = readFileSync("src/contracts/card.ts", "utf8");
  expect(aliases.filter((word) => contract.includes(word))).toEqual(aliases);
});
