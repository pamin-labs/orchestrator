import { expect, test } from "bun:test";
import type { Ctx } from "../src/api.ts";
import { Bus } from "../src/bus.ts";
import { openMemory, type DB } from "../src/db.ts";
import { ensureCheckout } from "../src/mech/checkout.ts";
import { fakeSandbox } from "./fake-sandbox.ts";

/**
 * Two ways a checkout goes wrong quietly.
 *
 * A shallow clone is faster and truncates history, which `rebaseOntoBase` and
 * `merge-base --is-ancestor` both need — and a future reader with a slow clone
 * in front of them reaches for `--depth=1` first.
 *
 * `ensureCheckout` had four early returns before it could ever throw. When one
 * fired the group ran a whole turn against an empty `/work`: status RUNNING, an
 * agent on the roster, no error anywhere.
 */
function harness(opts: { git?: boolean; project?: boolean; grp?: boolean; remote?: boolean } = {}) {
  const db: DB = openMemory();
  const bus = new Bus(db);
  const sandbox = fakeSandbox((cmd) => (cmd.includes("test -d") ? { out: "" } : {}));
  const ctx = {
    db,
    bus,
    sandbox,
    waiters: new Map(),
    git:
      opts.git === false
        ? undefined
        : ((async (_repo: string, argv: string[]) =>
            argv[0] === "remote" && opts.remote !== false
              ? { code: 0, out: "https://example.com/x.git", err: "" }
              : { code: 1, out: "", err: "no" }) as never),
    config: { language: "中文" },
  } as unknown as Ctx;

  if (opts.project !== false) {
    db.run("INSERT INTO project (name, repo_path, config_json, created_at) VALUES ('p', '/tmp/p', '{}', 0)");
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
  // Group 2 does not exist; the other three are the rows and the remote missing.
  const cases: [string, Awaited<ReturnType<typeof harness>>, number][] = [
    ["组 2", harness(), 2],
    ["git", harness({ git: false }), 1],
    ["project", harness({ project: false }), 1],
    ["remote origin", harness({ remote: false }), 1],
  ];

  for (const [needle, h, grpId] of cases) {
    await ensureCheckout(h.ctx, grpId);
    expect(h.sandbox.commands).toEqual([]);
    const bodies = h.said().map((e) => e.body);
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain(needle);
  }
});
