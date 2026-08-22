import { expect, test } from "bun:test";
import { sayIn } from "../../src/contracts/said.ts";
import { said as descriptorOf } from "../support/said.ts";
import { eq, sql } from "drizzle-orm";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { event } from "../../src/platform/persistence/schema.ts";
import { ensureCheckout, sandboxGit } from "../../src/mech/git/checkout.ts";
import { porcelainPaths, STATUS_Z } from "../../src/mech/git/gitops.ts";
import { WORK } from "../../src/mech/sandbox/sandbox.ts";
import * as fx from "../support/factories.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { testContext } from "../support/test-context.ts";

/**
 * Three ways a checkout goes wrong quietly, and one way it goes wrong loudly.
 *
 * A shallow clone is faster and truncates history, which `rebaseOntoBase` and
 * `merge-base --is-ancestor` both need — and a future reader with a slow clone in
 * front of them reaches for `--depth=1` first.
 */
/**
 * `ensureCheckout` had four early returns before it could ever throw, and when one
 * fired the group ran a whole turn against an empty `/work`: RUNNING, an agent on
 * the roster, no error anywhere. There are three now — "the host has no git" stopped
 * being a way this can fail when the remote stopped being read out of a host
 * checkout.
 */
async function harness(opts: { project?: boolean; grp?: boolean; remote?: boolean; modules?: boolean } = {}) {
  // `openMemory` hands back the one database, emptied — so a harness is a reseed
  // rather than a second instance, and two of them cannot be held at once.
  const db = await openMemory();
  const f = fx.on(db);
  const sandbox = fakeSandbox((cmd) => {
    if (cmd.includes(".gitmodules")) return { out: opts.modules ? "yes" : "" };
    if (cmd.includes("test -d")) return { out: "" };
    // No branch on the remote yet, so the checkout cuts one from the base.
    if (cmd.includes("ls-remote")) return { code: 2 };
    return {};
  });
  const ctx = await testContext({ db, sandbox });

  if (opts.project !== false) {
    await f.project.create({
      name: "p",
      remote: opts.remote === false ? null : "https://github.com/me/x.git",
    });
  }
  if (opts.grp !== false) {
    // A group whose project is gone. The foreign key is what normally stops
    // this; it does not stop a project deleted out from under a live group. In
    // Postgres it is a trigger, and `replica` is where `PRAGMA foreign_keys =
    // OFF` went — put back immediately, because the session outlives the row.
    const orphan = opts.project === false;
    if (orphan) await db.execute(sql`SET session_replication_role = replica`);
    try {
      await f.runningGrp.create({ project_id: 1, name: "g1", branch: "orch/g1" });
    } finally {
      if (orphan) await db.execute(sql`SET session_replication_role = origin`);
    }
  }
  const said = () => db.select({ meta: event.meta_json }).from(event).where(eq(event.severity, "blocker"));
  return { ctx, sandbox, said };
}

test("the clone is blobless, so history survives it", async () => {
  const { ctx, sandbox } = await harness();
  await ensureCheckout(ctx, 1);
  const clone = sandbox.commands.find((c) => c.startsWith("git clone"));
  expect(clone).toContain("--filter=blob:none");
  // The whole point: not the faster one that breaks rebase and merge-base.
  expect(clone).not.toContain("--depth");
});

test("every way out that is not a clone says which one it was", async () => {
  // Built one at a time: each harness empties the one database, so holding three
  // of them would leave the first two describing rows that are gone.
  // Named by descriptor rather than by a phrase in the rendered sentence: these
  // three go out in the language the panel is read in, and what distinguishes
  // them is which of the three messages was chosen.
  const cases: [{ id: string }, () => Promise<Awaited<ReturnType<typeof harness>>>, number][] = [
    [
      descriptorOf("no group {grp} in the grp table, so /work is still empty — there is no code to run this turn"),
      () => harness(),
      2,
    ],
    [
      descriptorOf(
        "the project is gone (project {project} is not there), so /work is still empty — there is no code to run this turn",
      ),
      () => harness({ project: false }),
      1,
    ],
    [
      descriptorOf(
        "project {project} has no remote recorded, so there is nothing to clone — /work is still empty and there is no code to run this turn",
      ),
      () => harness({ remote: false }),
      1,
    ],
  ];

  for (const [want, make, grpId] of cases) {
    const h = await make();
    await ensureCheckout(h.ctx, grpId);
    expect(h.sandbox.commands).toEqual([]);
    const events = await h.said();
    expect(events.length).toBe(1);
    expect(sayIn(events[0]?.meta)?.id).toBe(want.id);
  }
});

test("submodules are initialised in two steps, and only when there are any", async () => {
  // `git clone --recursive` is CVE-2024-32002 and CVE-2025-48384: a submodule
  // checkout that lands a hook where git then looks for one. The two steps are
  // the mitigation GitHub itself publishes, so collapsing them back into a flag
  // is the regression this exists to catch.
  const withModules = await harness({ modules: true });
  await ensureCheckout(withModules.ctx, 1);
  const clone = withModules.sandbox.commands.find((c) => c.startsWith("git clone"))!;
  expect(clone).not.toContain("--recursive");
  expect(clone).not.toContain("--recurse-submodules");
  const init = withModules.sandbox.commands.find((c) => c.includes("submodule update --init"))!;
  expect(init).toContain("protocol.file.allow=user");
  // Order: the working tree has to exist before `.gitmodules` can be read at all.
  expect(withModules.sandbox.commands.indexOf(clone)).toBeLessThan(withModules.sandbox.commands.indexOf(init));

  // A repository with no submodules pays one `test -f` and nothing else.
  const without = await harness();
  await ensureCheckout(without.ctx, 1);
  expect(without.sandbox.commands.filter((c) => c.includes("submodule"))).toEqual([]);
});

test("a warning on stderr does not become a changed path", async () => {
  // `sandboxGit` returned `out + err` with no separator, and `git status
  // --porcelain -z` is one NUL-terminated blob — so a single stderr line, and
  // `warning: unable to access '/root/.config/git/ignore'` is the common one
  // inside a container, was glued onto the last record. `porcelainPaths` then
  // sliced it at three characters and handed the remainder to
  // `reconcileOwnership`, which feeds paths straight to `git checkout --` and
  // `git clean -fd --`.
  const sandbox = fakeSandbox((cmd) => {
    if (!cmd.includes("'status'")) return {};
    return { out: " M src/a.ts\0", err: "warning: unable to access '/root/.config/git/ignore'" };
  });
  const ctx = await testContext({ sandbox });
  const r = await sandboxGit(ctx, { grp: 1 })(STATUS_Z, WORK);
  expect(porcelainPaths(r.out)).toEqual(["src/a.ts"]);
});
