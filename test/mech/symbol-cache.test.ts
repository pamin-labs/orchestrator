import { expect, test } from "bun:test";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { count, eq } from "drizzle-orm";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { StoredSpanExporter } from "../../src/platform/observability/span-store.ts";
import { installTracerProvider } from "../../src/platform/observability/traces.ts";
import { span } from "../../src/platform/persistence/schema.ts";
import { buildMap } from "../../src/mech/knowledge/repomap.ts";

/**
 * A grammar is loaded once per process, not once per project and not once per file.
 *
 * The number matters because of where the caller is: the watchdog's index rule runs
 * every tick, against every project, over every tracked file — at 6ms for the
 * runtime plus 0.6–3.6ms per grammar, a load keyed on the project would replace a
 * correctness bug with a performance one.
 */
/**
 * Asserted as a *delta* rather than a total, and the first version is why. It
 * expected exactly two loads, which passed alone and failed the moment it shared a
 * process with `symbols.test.ts`. A cache is a claim about the *second* call, so
 * measuring that directly is true under both `--isolate` and plain `bun test a b`,
 * and does not quietly become vacuous depending on which command ran it.
 */
test("a second project loads no grammar the first one already loaded", async () => {
  const db = await openMemory();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new StoredSpanExporter(db))] });
  installTracerProvider(provider);
  const loads = async () =>
    (await db.select({ n: count() }).from(span).where(eq(span.name, "symbols.grammar.load")))[0]?.n ?? 0;
  try {
    // Two Go files, so a per-file cache is distinguishable from a per-grammar one.
    const files = ["a.go", "b.go", "c.py"];
    const text: Record<string, string> = {
      "a.go": "func Alpha() {}\n",
      "b.go": "func Beta() {}\n",
      "c.py": "def gamma(): pass\n",
    };
    const read = (rel: string) => text[rel];

    const first = await buildMap("owner/one", () => files, [], read);
    await provider.forceFlush();
    const afterFirst = await loads();

    const second = await buildMap("owner/two", () => files, [], read);
    await provider.forceFlush();
    const afterSecond = await loads();

    // Both maps are real, so a zero delta below is not zero because nothing parsed.
    for (const map of [first, second]) {
      expect(map.flatMap((n) => n.files.flatMap((f) => f.symbols)).sort()).toEqual(["Alpha", "Beta", "gamma"]);
    }

    // Three files and two grammars in the first project: at most one load each,
    // never one per file. Then a second project over the same languages, and the
    // cache is keyed on the grammar rather than the caller, so it pays nothing.
    expect({ firstProject: afterFirst <= 2, secondProjectAdded: afterSecond - afterFirst }).toEqual({
      firstProject: true,
      secondProjectAdded: 0,
    });
  } finally {
    installTracerProvider(new NodeTracerProvider());
  }
});
