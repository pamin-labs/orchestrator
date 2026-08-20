/**
 * The one thing no role could do: open the page and click it.
 *
 * Every front-end slice carries an acceptance line like "the menu opens and shows
 * 不做了", and there is no browser in any sandbox — so QA passed on a code
 * reading, the Auditor refused the branch for missing evidence, and the boss was
 * asked to click by hand. Three groups sat on that at once.
 */
/**
 * A *step file*, not a script: `orch lease` never accepts a free command, and
 * that rule did not soften when the container became the boundary. The steps are
 * data — `{"goto"}`, `{"click"}`, `{"expect"}`, `{"shot"}`, `{"api"}`.
 *
 * The server under test is the one in *this worktree*, on a random port, against
 * a throwaway database, so a check can seed whatever state it needs and none can
 * touch the real one.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../src/composition/server.ts";
import { errText } from "../src/platform/process/text.ts";
import { z } from "zod";

/** A step file is somebody's JSON, so it is parsed rather than asserted into shape. */
const StepSchema = z.object({
  api: z.string().optional(),
  body: z.json().optional(),
  goto: z.string().optional(),
  click: z.string().optional(),
  type: z.string().optional(),
  into: z.string().optional(),
  expect: z.string().optional(),
  missing: z.string().optional(),
  shot: z.string().optional(),
});
type Step = z.infer<typeof StepSchema>;

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const stepsFile = arg("steps");
if (!stepsFile) {
  console.error("usage: browse.ts --steps <file.json> [--shot-dir <dir>]");
  process.exit(2);
}
// Outside the worktree on purpose: a screenshot dropped next to the code is one
// more thing the turn checkpoint's `git add -A` sweeps into the branch.
const shotDir = arg("shot-dir") ?? "/tmp/orch/shots";
mkdirSync(shotDir, { recursive: true });

let steps: Step[];
try {
  steps = z.array(StepSchema).parse(JSON.parse(readFileSync(stepsFile, "utf8")));
} catch (e) {
  console.error(`could not read steps from ${stepsFile}: ${errText(e)}`);
  process.exit(2);
}

// Playwright is a devDependency, so say what is missing rather than dying on an
// import error a role cannot act on.
let chromium: typeof import("playwright").chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed: `bun add -d playwright && bunx playwright install chromium`");
  process.exit(2);
}

// The worktree's `web/dist` is a symlink to the main checkout's build (that is how
// a fresh worktree gets a bundle at all). Serving that would test main's UI, not
// this group's — the exact confusion this whole resource exists to end. Replace it
// with a real build of the code under test.
const dist = join(process.cwd(), "web/dist");
if (lstatSync(dist, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(dist);
const built = Bun.spawnSync(["bun", "run", "build:web"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
if (built.exitCode !== 0) {
  console.error(`build:web failed, so the page under test would be stale:\n${built.stderr.toString().slice(-800)}`);
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), "orch-browse-"));
// 1, not 0. `ConfigSchema` requires a positive cap, so a zero here made every
// endpoint that parses the config answer 500 — the settings dialog could not be
// opened by this tool at all, which is the one surface it is most needed for.
// Nothing starts anyway: a fresh temp dataDir has no project to run.
const srv = await start({ dataDir, port: 0, maxGroups: 1 });
const browser = await chromium.launch();
const page = await browser.newPage();

let failed = 0;
try {
  for (const [i, s] of steps.entries()) {
    const label = `step ${i + 1}`;
    try {
      if (s.api) {
        // fallow-ignore-next-line security-sink -- the origin is `srv.url`, the throwaway server this script just started on a random local port; `s.api` only ever contributes a path to it.
        const r = await fetch(`${srv.url}${s.api}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(s.body ?? {}),
        });
        if (!r.ok) throw new Error(`${s.api} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
        console.log(`${label} api ${s.api}: ok`);
      }
      if (s.goto !== undefined) {
        await page.goto(`${srv.url}/${s.goto.replace(/^\//, "")}`, { waitUntil: "networkidle" });
        console.log(`${label} goto ${s.goto}: ok`);
      }
      if (s.click) {
        await page.click(s.click, { timeout: 5000 });
        console.log(`${label} click ${s.click}: ok`);
      }
      if (s.type !== undefined && s.into) {
        await page.fill(s.into, s.type, { timeout: 5000 });
        console.log(`${label} type into ${s.into}: ok`);
      }
      if (s.expect) {
        // Visible, not merely present: a menu that renders into a hidden portal is
        // the exact failure these checks exist to catch.
        await page.waitForSelector(`text=${s.expect}`, { state: "visible", timeout: 5000 });
        console.log(`${label} expect "${s.expect}": PASS`);
      }
      if (s.missing) {
        const n = await page.locator(`text=${s.missing}`).count();
        if (n > 0) throw new Error(`"${s.missing}" is on the page ${n} time(s)`);
        console.log(`${label} missing "${s.missing}": PASS`);
      }
      if (s.shot) {
        const path = join(shotDir, s.shot);
        await page.screenshot({ path, fullPage: true });
        console.log(`${label} shot: ${path}`);
      }
    } catch (e) {
      failed++;
      // The screenshot is the evidence QA could never produce; take one on failure
      // whether or not the step asked for it.
      const path = join(shotDir, `fail-${i + 1}.png`);
      await page.screenshot({ path, fullPage: true }).catch(() => {});
      console.log(`${label} FAIL: ${errText(e).split("\n")[0]}`);
      console.log(`${label} screenshot: ${path}`);
    }
  }
} finally {
  await browser.close();
  srv.stop();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failed ? `${failed}/${steps.length} step(s) failed` : `all ${steps.length} step(s) passed`);
process.exit(failed ? 1 : 0);
