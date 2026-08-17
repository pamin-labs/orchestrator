import { expect, test } from "bun:test";
import { z } from "zod";

const FallowConfig = z.object({
  entry: z.array(z.string()),
  boundaries: z.object({
    zones: z.array(z.object({ name: z.string(), patterns: z.array(z.string()) })),
    rules: z.array(
      z.object({ from: z.string(), allow: z.array(z.string()), allowTypeOnly: z.array(z.string()).optional() }),
    ),
  }),
});

const loadConfig = async () => FallowConfig.parse(await Bun.file(".fallowrc.json").json());

test("Fallow adds only undiscovered entry points and classifies directories by purpose", async () => {
  const config = await loadConfig();
  const zone = (name: string) => config.boundaries.zones.find((candidate) => candidate.name === name);
  const rule = (name: string) => config.boundaries.rules.find((candidate) => candidate.from === name);

  expect(config.entry).toEqual(["scripts/browse.ts", "scripts/make-github-app.ts"]);
  expect(zone("public-rpc")?.patterns).toEqual(["src/http/routes/**"]);
  expect(zone("shared-contracts")?.patterns).toEqual(["src/contracts/**"]);
  expect(zone("http-edge")?.patterns).toEqual(["src/http/**"]);
  expect(zone("runtime-adapters")?.patterns).toEqual(["src/runtime/**"]);
  expect(zone("mechanisms")?.patterns).toEqual(["src/ctx.ts", "src/mech/**"]);
  expect(zone("tests")?.patterns).toEqual(["test/**"]);
  expect(zone("scripts")?.patterns).toEqual(["scripts/**"]);
  expect(rule("web")).toEqual({ from: "web", allow: ["web", "shared-contracts"], allowTypeOnly: ["public-rpc"] });
  expect(rule("cli")).toEqual({ from: "cli", allow: ["cli", "shared-contracts"], allowTypeOnly: ["public-rpc"] });
  expect(rule("tests")).toBeUndefined();
  expect(rule("scripts")).toBeUndefined();

  const cli = await Bun.file("src/orch/cli.ts").text();
  expect(cli).not.toMatch(/from ["']\.\.\/(?:api|mech)\//);
  expect(cli).toContain('import type { OrchType } from "../http/routes/orch.ts"');
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
  expect(config.boundaries.zones.find(({ name }) => name === "application")?.patterns).toEqual([
    "src/runtime/executor.ts",
  ]);
  expect(config.boundaries.zones.find(({ name }) => name === "prompt")?.patterns).toEqual(["src/prompt/**"]);
  expect(config.boundaries.zones.find(({ name }) => name === "runtime-adapters")?.patterns).not.toContain(
    "src/runtime/executor.ts",
  );
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
