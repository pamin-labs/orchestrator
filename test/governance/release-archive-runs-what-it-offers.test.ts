import { expect, test } from "bun:test";
import { DevManifestSchema, KEPT, releasePackageJson } from "../../scripts/release-package-json.ts";

/**
 * A release archive offers only what it can run.
 *
 * The archive is a compiled binary plus a built panel — no `scripts/`, no
 * `web/src`, no `node_modules`. It shipped the development `package.json`
 * unchanged, so `bun run start` reached `dev` reached `build:web` and died on
 * `Module not found "scripts/build-web.ts"`: a file that was never in the
 * archive, naming a build the archive exists to have already done.
 */
/**
 * Thirty-nine scripts, seven of them runnable, and `start` — the one name every
 * ecosystem trains people to type — in the broken set. Measured on
 * `orch-server-0.1.7-darwin-arm64`.
 */
const dev = DevManifestSchema.parse(await Bun.file("package.json").json());

test("start runs the binary, not the build that produced it", () => {
  expect(releasePackageJson(dev, "orch-server").scripts).toMatchObject({ start: "./orch-server" });
  // Windows ships `orch-server.exe`, and the archive's own name for it is the
  // only thing that can be right here.
  expect(releasePackageJson(dev, "orch-server.exe").scripts).toMatchObject({ start: "./orch-server.exe" });
});

test("every script left in the archive is one the archive can run", () => {
  const out = releasePackageJson(dev, "orch-server");
  expect(Object.keys(out.scripts).sort()).toEqual(["start", ...KEPT.map(([n]) => n)].sort());
  // The entrypoint each kept script needs, checked against the repository —
  // which is where the release job copies them from.
  for (const [, needs] of KEPT) expect(Bun.file(needs).size).toBeGreaterThan(0);
});

/**
 * The reason `start` broke is that the whole list came across, so asserting on
 * the absences is asserting on the defect rather than on today's script names.
 */
test("nothing that needs the source tree survives into the archive", () => {
  const kept = Object.keys(releasePackageJson(dev, "orch-server").scripts);
  for (const gone of ["dev", "server", "build:web", "build:server", "test", "lint", "typecheck", "preflight"]) {
    expect(kept).not.toContain(gone);
  }
});

/**
 * Both bundles are `--target bun` single files with no external imports, so the
 * dependency lists describe nothing in the archive — and a helpful `bun install`
 * downloads all 104 of them to be ignored.
 */
test("an archive with no node_modules does not claim to need one", () => {
  const out = releasePackageJson(dev, "orch-server");
  expect(out).not.toHaveProperty("dependencies");
  expect(out).not.toHaveProperty("devDependencies");
  // Identity survives: the release job verifies this version against the tag.
  expect(out.version).toBe(dev.version);
  expect(out.name).toBe(dev.name);
});

/**
 * A renamed script must stop the release rather than thin the archive. Dropping
 * one silently is how `db:up` would go missing from a tarball nobody diffed.
 */
test("a kept script that no longer exists fails the release", () => {
  const { "db:up": _gone, ...rest } = dev.scripts ?? {};
  expect(() => releasePackageJson({ ...dev, scripts: rest }, "orch-server")).toThrow(/db:up/);
});
