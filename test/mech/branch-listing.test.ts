import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { makeGithub } from "../../src/mech/git/github.ts";
import { saveAuth } from "../../src/mech/sandbox/auth.ts";
import { listBranches } from "../../src/mech/git/checkout.ts";
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

function project(repoPath: string, answer: () => Response) {
  const db = openMemory();
  fx.project.insert(db, { name: "p", repo_path: repoPath });
  saveAuth(db, { runtime: "github", mode: "api_key", secret: "gho_x" });
  const asked: string[] = [];
  const ctx = testContext({
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

test("branches come back as names, in the order GitHub gave them", async () => {
  const { ctx, asked } = project("me/x", () => json([{ name: "main" }, { name: "release/2" }]));

  expect(await listBranches(ctx, 1)).toEqual(["main", "release/2"]);
  // One page. A repository with more than a hundred branches has more than this
  // control should render, and the rest stay typeable.
  expect(asked[0]).toContain("/repos/me/x/branches?per_page=100");
});

test("a repo_path that is a host directory is never sent to GitHub", async () => {
  // `repo_path` held a local checkout before it held `owner/name`, and both
  // shapes are still in the column. Pasting `/Users/me/code/x` into the API path
  // asks github.com for someone's home directory.
  const { ctx, asked } = project("/Users/me/code/x", () => json([{ name: "main" }]));

  expect(await listBranches(ctx, 1)).toEqual([]);
  expect(asked).toEqual([]);
});

test("a login that cannot list branches leaves the field typeable, not broken", async () => {
  // 404 is what GitHub answers for a private repository a token cannot see, so
  // this is the ordinary case of a boss who has not connected an account yet.
  const { ctx } = project("me/x", () => json({ message: "Not Found" }, 404));

  expect(await listBranches(ctx, 1)).toEqual([]);
});

test("a project that does not exist asks nothing", async () => {
  const { ctx, asked } = project("me/x", () => json([{ name: "main" }]));

  expect(await listBranches(ctx, 999)).toEqual([]);
  expect(asked).toEqual([]);
});

test("with no GitHub client at all the picker is empty rather than throwing", async () => {
  // `ctx.gh` is optional, and the settings page renders before anything is
  // connected. An exception here takes the whole panel down.
  const db = openMemory();
  fx.project.insert(db, { name: "p", repo_path: "me/x" });

  expect(await listBranches(testContext({ db }), 1)).toEqual([]);
});
