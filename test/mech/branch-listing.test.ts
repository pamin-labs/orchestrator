import { expect, test } from "bun:test";
import { count, eq, like } from "drizzle-orm";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { event, project as projectTable } from "../../src/platform/persistence/schema.ts";
import { makeGithub } from "../../src/mech/git/github.ts";
import { saveAuth } from "../../src/mech/sandbox/auth.ts";
import { baseBranch, listBranches } from "../../src/mech/git/checkout.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

/**
 * The base-branch picker's source of suggestions.
 *
 * It replaced a free-text box, and a typo in that box is not a typo — it is
 * every future group cut from a ref that does not exist. But the box stays
 * typeable on purpose, so every failure here has to come back as "no
 * suggestions" and never as an error the field surfaces.
 */

async function project(repoPath: string, answer: () => Response) {
  const db = await openMemory();
  await fx.on(db).project.create({ name: "p", repo_path: repoPath });
  await saveAuth(db, { runtime: "github", mode: "api_key", secret: "gho_x" });
  const asked: string[] = [];
  const ctx = await testContext({
    db,
    gh: makeGithub(db, async (url) => {
      asked.push(url);
      return answer();
    }),
  });
  return { ctx, asked };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** How many times the drift was said out loud. */
const announced = async (db: DB) =>
  (await db.select({ c: count() }).from(event).where(like(event.body, "%基线分支%")))[0]!.c;

test("branches come back as names, in the order GitHub gave them", async () => {
  const { ctx, asked } = await project("me/x", () => json([{ name: "main" }, { name: "release/2" }]));

  expect(await listBranches(ctx, 1)).toEqual(["main", "release/2"]);
  // One page. A repository with more than a hundred branches has more than this
  // control should render, and the rest stay typeable.
  expect(asked[0]).toContain("/repos/me/x/branches?per_page=100");
});

test("a repo_path that is a host directory is never sent to GitHub", async () => {
  // `repo_path` held a local checkout before it held `owner/name`, and both
  // shapes are still in the column. Pasting `/Users/me/code/x` into the API path
  // asks github.com for someone's home directory.
  const { ctx, asked } = await project("/Users/me/code/x", () => json([{ name: "main" }]));

  expect(await listBranches(ctx, 1)).toEqual([]);
  expect(asked).toEqual([]);
});

test("a login that cannot list branches leaves the field typeable, not broken", async () => {
  // 404 is what GitHub answers for a private repository a token cannot see, so
  // this is the ordinary case of a boss who has not connected an account yet.
  const { ctx } = await project("me/x", () => json({ message: "Not Found" }, 404));

  expect(await listBranches(ctx, 1)).toEqual([]);
});

test("a project that does not exist asks nothing", async () => {
  const { ctx, asked } = await project("me/x", () => json([{ name: "main" }]));

  expect(await listBranches(ctx, 999)).toEqual([]);
  expect(asked).toEqual([]);
});

test("with no GitHub client at all the picker is empty rather than throwing", async () => {
  // `ctx.gh` is optional, and the settings page renders before anything is
  // connected. An exception here takes the whole panel down.
  const db = await openMemory();
  await fx.on(db).project.create({ name: "p", repo_path: "me/x" });

  expect(await listBranches(await testContext({ db }), 1)).toEqual([]);
});

/**
 * A branch the boss picked survives the heartbeat.
 *
 * `baseBranch` asks GitHub for `default_branch` on every call — deliberately, since
 * a 304 is free — and wrote the answer over `base_branch` unconditionally. So a
 * branch chosen in settings was reverted within one tick: observed live, the boss
 * set `refactor/api-split-and-settings`, the feed announced a reversion to `main`
 * twice 29 seconds apart, and the stored value was `main`.
 */
/**
 * The pin is what tells a choice from a cached lookup. Emptying the box clears it,
 * which is how you go back to following the remote.
 */
test("a pinned base branch is not overwritten by the remote's default", async () => {
  const { ctx } = await project("me/x", () => json({ full_name: "me/x", default_branch: "main" }));
  // A real boolean now, so `1` would be a type error rather than a pin.
  await ctx.db
    .update(projectTable)
    .set({ base_branch: "develop", base_branch_pinned: true })
    .where(eq(projectTable.id, 1));

  expect(await baseBranch(ctx, 1)).toBe("develop");
  expect(await baseBranch(ctx, 1)).toBe("develop");
  const [row] = await ctx.db.select({ b: projectTable.base_branch }).from(projectTable).where(eq(projectTable.id, 1));
  expect(row!.b).toBe("develop");
  // And it says nothing, because nothing changed.
  expect((await ctx.db.select({ c: count() }).from(event))[0]!.c).toBe(0);
});

/**
 * Two callers on one tick announce the drift once between them.
 *
 * `baseBranch` runs from the heartbeat's index pass and from watchdog rule 7e, and
 * both read the row before either writes — so each saw the old value, each wrote,
 * and each announced it. That is the duplicate the live feed showed.
 *
 * Sequential calls never reproduced it, because the second reads what the first
 * wrote. The concurrency is the test.
 */
test("two callers racing on one tick announce the change once", async () => {
  const { ctx } = await project("me/x", () => json({ full_name: "me/x", default_branch: "main" }));
  await ctx.db
    .update(projectTable)
    .set({ base_branch: "old", base_branch_pinned: false })
    .where(eq(projectTable.id, 1));

  await Promise.all([baseBranch(ctx, 1), baseBranch(ctx, 1), baseBranch(ctx, 1)]);

  expect(await announced(ctx.db)).toBe(1);
});

test("an unpinned base branch still follows the remote, and says so once", async () => {
  const { ctx } = await project("me/x", () => json({ full_name: "me/x", default_branch: "main" }));
  await ctx.db
    .update(projectTable)
    .set({ base_branch: "old", base_branch_pinned: false })
    .where(eq(projectTable.id, 1));

  expect(await baseBranch(ctx, 1)).toBe("main");
  // Twice more: the drift is announced on the transition, not on every tick.
  await baseBranch(ctx, 1);
  await baseBranch(ctx, 1);
  expect(await announced(ctx.db)).toBe(1);
});
