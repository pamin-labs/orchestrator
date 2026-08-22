import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const FallowConfig = z.object({
  entry: z.array(z.string()),
  boundaries: z.object({
    zones: z.array(z.object({ name: z.string(), patterns: z.array(z.string()) })),
    rules: z.array(
      z.object({ from: z.string(), allow: z.array(z.string()), allowTypeOnly: z.array(z.string()).optional() }),
    ),
  }),
  security: z.object({ categories: z.object({ include: z.array(z.string()) }) }),
});

const loadConfig = async () => FallowConfig.parse(await Bun.file(".fallowrc.json").json());

test("Fallow adds only undiscovered entry points and classifies directories by purpose", async () => {
  const config = await loadConfig();
  const zones = Object.fromEntries(config.boundaries.zones.map(({ name, patterns }) => [name, patterns]));
  const rules = Object.fromEntries(config.boundaries.rules.map((rule) => [rule.from, rule]));

  // Every entry here is reached through a string Fallow cannot follow, which is
  // the only reason to list one. `main.tsx` used to be discovered from the
  // `bun build` line in package.json and now sits inside `scripts/build-web.ts`;
  // `loader.ts` is the `bunfig.toml` preload, and it reaches `coverage.ts` and
  // the catalog plugin from there. `scripts/lingui.config.js` is deliberately
  // *not* here: it is an entry in the same sense, but listing it would make its
  // `@lingui/format-po` import look like a production dependency, so that one
  // carries a suppression instead.
  expect(config.entry).toEqual([
    "scripts/browse.ts",
    "scripts/make-github-app.ts",
    "web/src/app/main.tsx",
    "test/support/loader.ts",
  ]);
  expect(config.security.categories.include).toContain("hardcoded-secret");
  expect(config.security.categories.include).toContain("secret-to-network");
  expect(new Set(config.security.categories.include).size).toBe(config.security.categories.include.length);
  // No verbatim copy of the zone list. It used to be repeated here in full, which
  // made `.fallowrc.json` a thing with two owners: adding a zone meant editing
  // both, and the test failing said only that the two files disagreed — never
  // which of them was right. Fallow is the owner and enforces the rules; what
  // belongs here is the property those rules have to keep, which no tool checks.
  //
  // Every zone is a directory. Zones used to carry file lists — `src/api.ts`,
  // `src/ctx.ts`, `src/lang.ts`, `src/observability.ts`, `src/scheduler.ts` —
  // because those files sat at the source root with nowhere to belong. A list is
  // a thing to forget: a new root file joins whichever zone somebody remembers
  // to edit, and `coverage.requireAllFiles` is the only thing that would have
  // noticed. The one exception is `build-info`, which is a single file on
  // purpose so executables can read the version without reaching into platform.
  for (const [name, patterns] of Object.entries(zones)) {
    if (name === "build-info") continue;
    for (const pattern of patterns) expect(pattern).toEndWith("/**");
  }
  expect(rules.web).toEqual({ from: "web", allow: ["web", "shared-contracts"], allowTypeOnly: ["public-rpc"] });
  expect(rules.cli).toEqual({
    from: "cli",
    allow: ["cli", "build-info", "shared-contracts"],
    allowTypeOnly: ["public-rpc"],
  });
  expect(rules.tests).toBeUndefined();
  expect(rules.scripts).toBeUndefined();

  const cli = await Bun.file("src/orch/cli.ts").text();
  expect(cli).not.toMatch(/from ["']\.\.\/(?:api|mech)\//);
  expect(cli).toContain('import type { OrchType } from "../http/routes/orch.ts"');
});

test("a shared contract is shared — every file in src/contracts crosses a zone", () => {
  // `src/contracts` is reachable from everywhere by design, which makes it the
  // one directory where a misplaced file draws no boundary error. A file only
  // one zone imports is not a contract: it is that zone's private type filed
  // where nothing can tell it apart from the wire. `idempotency.ts` sat here
  // and only `src/http` ever read it.
  const zoneOf = (path: string) => (path.startsWith("web/") ? "web" : path.split("/")[1]);
  const sources = [
    ...new Bun.Glob("src/**/*.ts").scanSync({ cwd: "." }),
    ...new Bun.Glob("web/src/**/*.{ts,tsx}").scanSync({ cwd: "." }),
  ];
  const readers = new Map<string, Set<string>>();
  for (const path of sources) {
    const zone = zoneOf(path);
    if (zone === "contracts") continue;
    for (const match of readFileSync(path, "utf8").matchAll(/from "[^"]*contracts\/([\w-]+)(?:\.ts)?"/g)) {
      const file = `${match[1]}.ts`;
      const set = readers.get(file) ?? new Set<string>();
      set.add(zone!);
      readers.set(file, set);
    }
  }
  const single = [...new Bun.Glob("src/contracts/*.ts").scanSync({ cwd: "." })]
    .map((path) => path.slice("src/contracts/".length))
    .filter((file) => (readers.get(file)?.size ?? 0) < 2)
    .toSorted();
  expect(single).toEqual([]);
});

test("constrained production zones form one explicit dependency DAG", async () => {
  const config = await loadConfig();
  const zones = new Set(config.boundaries.zones.map(({ name }) => name));
  const rules = new Map(config.boundaries.rules.map((rule) => [rule.from, rule]));

  expect(rules.size).toBe(config.boundaries.rules.length);
  expect([...rules.keys()].sort()).toEqual(
    [
      "api",
      "application",
      "build-info",
      "cli",
      "composition",
      "http-edge",
      "mechanisms",
      "platform",
      "prompt",
      "public-rpc",
      "runtime-adapters",
      "shared-contracts",
      "web",
    ].sort(),
  );
  // The turn executor is application logic, not an adapter: it drives the
  // provider clients rather than being one. That used to be said by naming
  // `src/runtime/executor.ts` inside the application zone — a carve-out that
  // contradicted where the file sat. It sits in `src/application/` now, so the
  // directory says it and the config does not have to.
  expect(config.boundaries.zones.find(({ name }) => name === "application")?.patterns).toEqual(["src/application/**"]);
  expect(config.boundaries.zones.find(({ name }) => name === "prompt")?.patterns).toEqual(["src/prompt/**"]);
  expect(existsSync("src/runtime/executor.ts")).toBe(false);
  expect(rules.get("runtime-adapters")?.allow).not.toContain("mechanisms");

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (zone: string): void => {
    if (visiting.has(zone)) throw new Error(`dependency zone cycle reaches ${zone}`);
    if (visited.has(zone)) return;
    visiting.add(zone);
    const rule = rules.get(zone);
    expect(rule).toBeDefined();
    for (const target of [...(rule?.allow ?? []), ...(rule?.allowTypeOnly ?? [])]) {
      expect(zones.has(target)).toBeTrue();
      if (target !== zone) visit(target);
    }
    visiting.delete(zone);
    visited.add(zone);
  };

  for (const zone of rules.keys()) visit(zone);
});
