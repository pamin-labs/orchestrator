import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";

/**
 * `load.ts` states that adding a role is a new yaml file and nothing else. That
 * was false for 39 call sites until capabilities existed, and nothing stopped it
 * being false again — a literal dispatches correctly today and silently pins the
 * flow to one roster, so no test fails when the next one is added.
 */

/** The roster, from the directory, so a new role is covered without editing this. */
const ROLES = readdirSync("roles")
  .filter((entry) => entry.endsWith(".yaml"))
  .map((entry) => entry.slice(0, -".yaml".length));

/**
 * `orchestrator` is the system's own name on a bus frame, not a role anything
 * hires — `roles/` has no yaml for it, so it cannot be resolved by capability and
 * is not what this guard is about.
 */
test("no flow code dispatches or compares against a role by name", async () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "src"], { stdout: "pipe", stderr: "pipe" });
  expect(listed.exitCode).toBe(0);

  // Where a role name would land: enqueued as a payload, or compared to a caller's.
  const patterns = ROLES.flatMap((role) => [
    { role, re: new RegExp(`role:\\s*"${role}"`) },
    { role, re: new RegExp(`role\\s*[!=]==\\s*"${role}"`) },
  ]);
  const violations: string[] = [];

  for (const path of listed.stdout.toString().split("\0").filter(Boolean)) {
    if (!path.endsWith(".ts")) continue;
    // The registry itself, and the loader that reads the yaml, name roles by
    // definition — that is what they are for.
    if (path === "src/platform/config/load.ts" || path === "src/mech/ctx.ts") continue;
    const text = await Bun.file(path).text();
    for (const [index, line] of text.split("\n").entries()) {
      for (const { role, re } of patterns) {
        if (re.test(line)) violations.push(`${path}:${index + 1} names "${role}"; ask for a capability instead`);
      }
    }
  }

  expect(violations).toEqual([]);
});
