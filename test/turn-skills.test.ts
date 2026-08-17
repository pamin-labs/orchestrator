import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySkills } from "../src/application/turn/delta.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { testContext } from "./test-context.ts";
import type { Delta } from "../src/prompt/assemble.ts";

/**
 * Which skill text a turn is given, and — more to the point — what happens when
 * it is asked for one that is not there.
 *
 * The names travel on the job payload and the bodies are read at turn time from
 * inside the container, so every failure here is silent by construction: the
 * agent simply does not receive the instructions it was told to follow.
 */

function repoWithSkill(name: string, body: string): string {
  const repo = mkdtempSync(join(tmpdir(), "orch-skills-"));
  const dir = join(repo, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} does a thing\n---\n\n${body}\n`);
  return repo;
}

const turnJob = (skills: string[]) => ({ grp_id: 1, payload: { skills } });

const agent = { id: 1, project_id: 1, role: "engineer" };

/**
 * The host checkout says which skills exist; the container holds the text the
 * agent is actually given. A test that seeds only one of the two is testing the
 * wrong half, so both are seeded here.
 */
async function run(repo: string, wanted: string[], inContainer: Record<string, string> = {}): Promise<Delta> {
  const sandbox = fakeSandbox();
  for (const [path, body] of Object.entries(inContainer)) sandbox.files.set(path, body);
  const ctx = testContext({ sandbox });
  ctx.db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', ?, 0)", [repo]);
  ctx.db.run("INSERT INTO grp (project_id, name, created_at) VALUES (1, 'g', 0)");
  const delta: Delta = {};
  await applySkills(ctx, agent, turnJob(wanted), { grp: 1 }, delta);
  return delta;
}

const inContainer = (name: string, body: string) => ({
  [`/work/.claude/skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: ${name} does a thing\n---\n\n${body}\n`,
});

test("a turn that asked for no skill is given none", async () => {
  const delta = await run(repoWithSkill("commit", "how to commit"), []);
  expect(delta.skills).toBeUndefined();
});

test("a named skill arrives as text the agent can act on", async () => {
  const delta = await run(
    repoWithSkill("commit", "…"),
    ["commit"],
    inContainer("commit", "state the finding, not the diff"),
  );
  expect(delta.skills).toContain("state the finding, not the diff");
});

test("a skill the repository does not have leaves the delta empty rather than half-built", async () => {
  // The payload carries names chosen when the turn was planned; the repository
  // can have moved on. Filling `skills` with an empty string would tell the
  // prompt assembler there is a section when there is not.
  const delta = await run(repoWithSkill("commit", "…"), ["a-skill-that-was-deleted"]);
  expect(delta.skills).toBeUndefined();
});

test("the skills that do exist still arrive when one of the names does not", async () => {
  const delta = await run(repoWithSkill("commit", "…"), ["commit", "gone"], inContainer("commit", "state the finding"));
  expect(delta.skills).toContain("state the finding");
});

test("a skill whose file cannot be read says so instead of arriving blank", async () => {
  const repo = repoWithSkill("commit", "state the finding");
  const ctx = testContext({
    // The container is what holds the checkout, and it can refuse. A blank
    // section would read as "this skill has no instructions".
    sandbox: fakeSandbox(() => ({ code: 1, err: "no such container" })),
  });
  ctx.db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', ?, 0)", [repo]);
  ctx.db.run("INSERT INTO grp (project_id, name, created_at) VALUES (1, 'g', 0)");
  const delta: Delta = {};

  await applySkills(ctx, agent, turnJob(["commit"]), { grp: 1 }, delta);

  expect(delta.skills).toContain("could not be read");
});
