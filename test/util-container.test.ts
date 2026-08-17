import { expect, test } from "bun:test";
import { openMemory } from "../src/platform/persistence/database.ts";
import { readOnlyGitPaths, saveAuth, vaultFor } from "../src/mech/sandbox/auth.ts";
import { UTIL, isUtil, utilSandbox } from "../src/mech/sandbox/sandbox.ts";

/**
 * The third kind of container, and the one rule that pays for it.
 *
 * 005 said "the container is the boundary". 007 narrows it by a word: **a
 * container that runs an agent** is the boundary. One with no agent in it is a
 * peer of the server, so it may hold the real GitHub login — and every container
 * that does run an agent must then be unable to write to the remote, or the
 * split has bought nothing.
 *
 * That second half is not a property of the token, which can write: it is a
 * property of the binding. Which makes it exactly the kind of thing that is true
 * until somebody edits one line of `auth.ts`, and exactly why it is asserted
 * here rather than described in a comment.
 */

function withGithub() {
  const db = openMemory();
  saveAuth(db, { runtime: "github", mode: "api_key", secret: "gho_write_capable" });
  return db;
}

test("a group's binding covers a fetch and stops at the packfile push", () => {
  const db = withGithub();
  const bound = vaultFor(db, { repo: "https://github.com/me/x.git" }).credentials.find((c) => c.name === "github")!;

  // Both requests a fetch makes. Without the first, a private repository cannot
  // even be discovered; without the second, the clone gets no objects.
  expect(bound.paths).toContain("/me/x.git/info/refs");
  expect(bound.paths).toContain("/me/x.git/git-upload-pack");

  // The one that carries the packfile. Injection here would make every group
  // able to write to the remote, which is the whole thing being prevented.
  expect(bound.paths).not.toContain("/me/x.git/git-receive-pack");

  // And not by a wildcard, which is the trap: the sidecar matches a trailing `*`
  // as a prefix that does NOT stop at `/`, so `/me/x.git*` — the shape upstream's
  // own guide suggests — would readmit `git-receive-pack` while looking careful.
  for (const p of bound.paths!) expect(p.endsWith("*")).toBe(false);
});

test("the utility container's binding is not the group's", () => {
  // 007: "its egress bindings are not the group containers' — only it is bound
  // for GitHub writes." No repo, no path filter, so the push it exists to make
  // is the one request in the system that gets a credential on a write path.
  const db = withGithub();
  const util = vaultFor(db).credentials.find((c) => c.name === "github")!;
  expect(util.paths).toBeUndefined();

  const group = vaultFor(db, { repo: "git@github.com:me/x.git" }).credentials.find((c) => c.name === "github")!;
  expect(group.paths).toBeDefined();
  // Same token, two bindings. If these ever come out equal, the split is gone.
  expect(util.value).toBe(group.value);
  expect(util.paths).not.toEqual(group.paths);
});

test("the paths follow the remote's own spelling, not a guess at it", () => {
  // git asks for whatever the remote URL says. A remote without `.git` produces
  // paths without it, and hardcoding either form means the credential is never
  // injected for half the projects — which presents as "this private repo will
  // not clone" rather than as anything about paths.
  expect(readOnlyGitPaths("https://github.com/me/x.git")).toEqual(["/me/x.git/info/refs", "/me/x.git/git-upload-pack"]);
  expect(readOnlyGitPaths("https://github.com/me/x")).toEqual(["/me/x/info/refs", "/me/x/git-upload-pack"]);
  expect(readOnlyGitPaths("git@github.com:me/x.git")).toEqual(["/me/x.git/info/refs", "/me/x.git/git-upload-pack"]);
  // Not GitHub: no paths rather than paths built out of nothing.
  expect(readOnlyGitPaths("https://gitlab.com/me/x.git")).toBeNull();
});

test("the utility container is one per orchestrator and owns no row", () => {
  // It belongs to no group and no project, so its id lives beside the other
  // server-scope settings. Nothing there yet means it has never been built,
  // which is the ordinary state — it is made on the first push.
  const db = openMemory();
  expect(isUtil(UTIL)).toBe(true);
  expect(isUtil({ grp: 1 })).toBe(false);
  expect(utilSandbox(db)).toEqual({ id: null, at: 0 });
});
