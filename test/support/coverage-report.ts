import { Glob } from "bun";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

/**
 * Renders the map `test/support/coverage.ts` left behind.
 *
 * Separate from the plugin because the plugin has to dump after every test file
 * — `bun test` fires no exit hook — and rendering lcov plus HTML a hundred times
 * would cost more than the instrumentation does.
 */
const dir = process.env.COVERAGE_DIR ?? "coverage";

// Our own dump, but still JSON off disk. `createCoverageMap` reads `.statementMap`
// and `.s` off every entry and throws somewhere deep if they are missing, so the
// shape is checked here where the message can name the file.
function isCoverageMap(value: unknown): value is libCoverage.CoverageMapData {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every(
    (entry) => typeof entry === "object" && entry !== null && "statementMap" in entry && "s" in entry,
  );
}

/**
 * Every worker's shard, added together.
 *
 * `bun test --parallel` runs each file in one of several processes and
 * `globalThis.__coverage__` is per-process, so each shard knows only about the
 * files its worker loaded. Merging is `istanbul-lib-coverage`'s own job:
 * `merge` sums the hit counts for a file two shards both touched and keeps the
 * maps, which is the arithmetic rather than an approximation of it.
 */
const map = libCoverage.createCoverageMap({});
let shards = 0;
for (const shard of new Glob("*.json").scanSync({ cwd: `${dir}/parts`, absolute: true })) {
  const stored: unknown = await Bun.file(shard).json();
  if (!isCoverageMap(stored)) {
    console.error(`${shard} is not an Istanbul coverage map`);
    process.exit(1);
  }
  map.merge(stored);
  shards += 1;
}
if (shards === 0) {
  console.error(`no coverage shards under ${dir}/parts — run bun run test:coverage`);
  process.exit(1);
}
// Written before the reports: Fallow reads this file, the reports are for people.
await Bun.write(`${dir}/coverage-final.json`, JSON.stringify(map.toJSON()));
const context = libReport.createContext({ dir, coverageMap: map });
// `lcov` for anything downstream that reads lcov, `html` for a human, and
// `text-summary` so a CI log carries the number without an artifact download.
// Fallow reads `coverage-final.json` itself and needs none of these.
reports.create("lcov").execute(context);
reports.create("html", { subdir: "html" }).execute(context);
reports.create("text-summary").execute(context);
