import { expect, test } from "bun:test";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { SqliteSpanExporter } from "../../src/platform/observability/span-store.ts";
import { installTracerProvider } from "../../src/platform/observability/traces.ts";
import { treeHeads } from "../../src/mech/git/checkout.ts";
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

const spans = (db: DB) => db.query<{ name: string; status: string }, []>("SELECT name, status FROM span").all();

test("reading the corpus out of a container is timed", async () => {
  const t = traced(() => ({ out: `${MARKER}a.ts\nexport const a = 1\n` }));
  try {
    const heads = await treeHeads(t.ctx, { grp: 1 }, 64);
    await t.provider.forceFlush();
    expect([...heads.keys()]).toEqual(["a.ts"]);
    expect(spans(t.db).map((s) => s.name)).toEqual(["git.tree_heads"]);
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
    expect(spans(t.db)).toEqual([{ name: "git.tree_heads", status: "error" }]);
  } finally {
    installTracerProvider(new NodeTracerProvider());
  }
});
