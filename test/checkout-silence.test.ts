import { expect, test } from "bun:test";
import { openMemory, type DB } from "../src/db.ts";
import { ensureCheckout } from "../src/mech/git/checkout.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { testContext } from "./test-context.ts";

/**
 * Three ways a checkout goes wrong quietly, and one way it goes wrong loudly.
 *
 * A shallow clone is faster and truncates history, which `rebaseOntoBase` and
 * `merge-base --is-ancestor` both need — and a future reader with a slow clone
 * in front of them reaches for `--depth=1` first.
 *
 * `ensureCheckout` had four early returns before it could ever throw. When one
 * fired the group ran a whole turn against an empty `/work`: status RUNNING, an
 * agent on the roster, no error anywhere. There are three now — "the host has no
 * git" stopped being a way this can fail when the remote stopped being read out
 * of a host checkout (007 step 5).
 */
function harness(opts: { project?: boolean; grp?: boolean; remote?: boolean; modules?: boolean } = {}) {
  const db: DB = openMemory();
  const sandbox = fakeSandbox((cmd) => {
    if (cmd.includes(".gitmodules")) return { out: opts.modules ? "yes" : "" };
    if (cmd.includes("test -d")) return { out: "" };
    // No branch on the remote yet, so the checkout cuts one from the base.
    if (cmd.includes("ls-remote")) return { code: 2 };
    return {};
  });
  const ctx = testContext({ db, sandbox });

  if (opts.project !== false) {
    db.run(
      "INSERT INTO project (name, repo_path, remote, config_json, created_at) VALUES ('p', '/tmp/p', ?, '{}', 0)",
      [opts.remote === false ? null : "https://github.com/me/x.git"],
    );
  } else {
    // A group whose project is gone. The foreign key is what normally stops
    // this; it does not stop a project deleted out from under a live group.
    db.run("PRAGMA foreign_keys = OFF");
  }
  if (opts.grp !== false) {
    db.run("INSERT INTO grp (project_id, name, status, branch, created_at) VALUES (1, 'g1', 'RUNNING', 'orch/g1', 0)");
  }
  const said = () => db.query<{ body: string }, []>("SELECT body FROM event WHERE severity = 'blocker'").all();
  return { ctx, sandbox, said };
}

test("the clone is blobless, so history survives it", async () => {
  const { ctx, sandbox } = harness();
  await ensureCheckout(ctx, 1);
  const clone = sandbox.commands.find((c) => c.startsWith("git clone"));
  expect(clone).toContain("--filter=blob:none");
  // The whole point: not the faster one that breaks rebase and merge-base.
  expect(clone).not.toContain("--depth");
});

test("every way out that is not a clone says which one it was", async () => {
  const cases: [string, Awaited<ReturnType<typeof harness>>, number][] = [
    ["组 2", harness(), 2],
    ["项目不在了", harness({ project: false }), 1],
    ["没记下 remote", harness({ remote: false }), 1],
  ];

  for (const [needle, h, grpId] of cases) {
    await ensureCheckout(h.ctx, grpId);
    expect(h.sandbox.commands).toEqual([]);
    const bodies = h.said().map((e) => e.body);
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain(needle);
  }
});

test("submodules are initialised in two steps, and only when there are any", async () => {
  // `git clone --recursive` is CVE-2024-32002 and CVE-2025-48384: a submodule
  // checkout that lands a hook where git then looks for one. The two steps are
  // the mitigation GitHub itself publishes, so collapsing them back into a flag
  // is the regression this exists to catch.
  const withModules = harness({ modules: true });
  await ensureCheckout(withModules.ctx, 1);
  const clone = withModules.sandbox.commands.find((c) => c.startsWith("git clone"))!;
  expect(clone).not.toContain("--recursive");
  expect(clone).not.toContain("--recurse-submodules");
  const init = withModules.sandbox.commands.find((c) => c.includes("submodule update --init"))!;
  expect(init).toContain("protocol.file.allow=user");
  // Order: the working tree has to exist before `.gitmodules` can be read at all.
  expect(withModules.sandbox.commands.indexOf(clone)).toBeLessThan(withModules.sandbox.commands.indexOf(init));

  // A repository with no submodules pays one `test -f` and nothing else.
  const without = harness();
  await ensureCheckout(without.ctx, 1);
  expect(without.sandbox.commands.some((c) => c.includes("submodule"))).toBe(false);
});
