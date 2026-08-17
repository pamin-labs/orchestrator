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
const file = Bun.file(`${dir}/coverage-final.json`);
if (!(await file.exists())) {
  console.error(`no coverage map at ${dir}/coverage-final.json — run bun run test:coverage`);
  process.exit(1);
}

// Our own dump, but still JSON off disk. `createCoverageMap` reads `.statementMap`
// and `.s` off every entry and throws somewhere deep if they are missing, so the
// shape is checked here where the message can name the file.
function isCoverageMap(value: unknown): value is libCoverage.CoverageMapData {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every(
    (entry) => typeof entry === "object" && entry !== null && "statementMap" in entry && "s" in entry,
  );
}

const stored: unknown = await file.json();
if (!isCoverageMap(stored)) {
  console.error(`${dir}/coverage-final.json is not an Istanbul coverage map`);
  process.exit(1);
}
const map = libCoverage.createCoverageMap(stored);
const context = libReport.createContext({ dir, coverageMap: map });
// `lcov` for anything downstream that reads lcov, `html` for a human, and
// `text-summary` so a CI log carries the number without an artifact download.
// Fallow reads `coverage-final.json` itself and needs none of these.
reports.create("lcov").execute(context);
reports.create("html", { subdir: "html" }).execute(context);
reports.create("text-summary").execute(context);
