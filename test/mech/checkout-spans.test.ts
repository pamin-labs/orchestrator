import { expect, test } from "bun:test";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { SqliteSpanExporter } from "../../src/platform/observability/span-store.ts";
import { installTracerProvider } from "../../src/platform/observability/traces.ts";
import { listTree, treeHeads } from "../../src/mech/git/checkout.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { testContext } from "../support/test-context.ts";

/**
 * The corpus read is a container round trip whose cost scales with the
 * repository, and the watchdog makes it once per project per tick.
 *
 * Without a span it is invisible in 系统耗时, and invisible reads as free: the
 * index rule showed one number and nothing said whether it was waiting on the
 * container or on the GitHub call above it. `AGENTS.md` requires a span on
 * anything that waits, and this is the check that the requirement was met rather
 * than only written down.
 */

/** The record separator `treeHeads` prints before each path. */
const MARKER = "==";

function traced(handler: Parameters<typeof fakeSandbox>[0]) {
  const db = openMemory();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new SqliteSpanExporter(db))] });
  installTracerProvider(provider);
  return { db, provider, ctx: testContext({ db, sandbox: fakeSandbox(handler) }) };
}

/**
 * The spans that were written, by name — deliberately not in time order.
 *
 * `ORDER BY started_at` is not a total order: a parent and the child it opens
 * immediately can share a millisecond, and which SQLite returns first is then the
 * storage engine's choice. That failed this file about one run in ten with the two
 * rows transposed, and the transposition meant nothing.
 *
 * Nesting has its own helper below, which reads parent ids rather than a clock.
 */
const spans = (db: DB) =>
  db.query<{ name: string; status: string }, []>("SELECT name, status FROM span ORDER BY name").all();

/** Which span each one hangs off, by name, so nesting is assertable without ids. */
const parents = (db: DB) =>
  Object.fromEntries(
    db
      .query<{ name: string; parent: string | null }, []>(
        "SELECT c.name, p.name AS parent FROM span c LEFT JOIN span p ON p.span_id = c.parent_span_id",
      )
      .all()
      .map((r) => [r.name, r.parent]),
  );

test("reading the corpus out of a container is timed", async () => {
  const t = traced(() => ({ out: `${MARKER}a.ts\nexport const a = 1\n` }));
  try {
    const heads = await treeHeads(t.ctx, { grp: 1 }, 64);
    await t.provider.forceFlush();
    expect([...heads.keys()]).toEqual(["a.ts"]);
    // The container round trip nests under the read that made it, so "the index
    // rule is slow" resolves one level further than it used to.
    expect(parents(t.db)).toEqual({ "git.tree_heads": null, "sandbox.exec": "git.tree_heads" });
  } finally {
    installTracerProvider(new NodeTracerProvider());
  }
});

test("a container that refuses marks the span, and still answers empty", async () => {
  // The caller keeps the answer it always had: an unreadable corpus means
  // "nothing changed", which is the safe product behaviour and must not become an
  // exception. What changes is that the round trip it spent failing no longer
  // looks, in the one surface built to answer "which stage is slow", exactly like
  // one that succeeded.
  const t = traced(() => ({ code: 128, err: "not a git repository" }));
  try {
    expect(await treeHeads(t.ctx, { grp: 1 }, 64)).toEqual(new Map());
    await t.provider.forceFlush();
    // One of the two, and the distinction is the point: the container answered,
    // so `sandbox.exec` succeeded — a command that exits non-zero inside a
    // healthy container is not a transport failure. `execIn` marks its span only
    // for exit 126, which it reserves for a container it could not reach at all.
    expect(spans(t.db)).toEqual([
      { name: "git.tree_heads", status: "error" },
      { name: "sandbox.exec", status: "unset" },
    ]);
  } finally {
    installTracerProvider(new NodeTracerProvider());
  }
});

/**
 * The repo-map rule's dominant cost, and the failure it used to hide.
 *
 * `listTree` never throws: an unreachable mirror and a non-zero `ls-tree` both
 * come back as an empty list with a sentence in `why`. So a span that set
 * `ERROR` only in its `catch` could not set it at all, and a failed clone
 * measured the same as a successful read — fifty lines from where `treeHeads`
 * already had that fixed. `why` is not the signal on its own: an empty
 * repository produces one too, from a command that worked.
 */

test("a failed ls-tree marks the span, and an empty repository does not", async () => {
  const failing = traced((cmd) =>
    cmd.includes("ls-tree") ? { code: 128, out: "fatal: not a valid object name" } : {},
  );
  try {
    // Only `ls-tree` fails: the `test -d` and the bare clone before it succeed,
    // so this is the path where the mirror is fine and the read is not.
    const r = await listTree(failing.ctx, "owner/repo", "main");
    await failing.provider.forceFlush();
    expect(r.files).toEqual([]);
    expect(r.why).toContain("exited 128");
    expect(spans(failing.db).find((s) => s.name === "git.ls_tree")?.status).toBe("error");
  } finally {
    installTracerProvider(new NodeTracerProvider());
  }

  const empty = traced(() => ({ out: "" }));
  try {
    const r = await listTree(empty.ctx, "owner/repo", "main");
    await empty.provider.forceFlush();
    // Still a sentence for the caller, because "nothing here" is worth saying.
    expect(r.why).toContain("lists no files");
    // But the command ran and the ref resolved, so the span is not a failure.
    expect(spans(empty.db).find((s) => s.name === "git.ls_tree")?.status).not.toBe("error");
  } finally {
    installTracerProvider(new NodeTracerProvider());
  }
});
