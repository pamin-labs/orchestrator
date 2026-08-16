import { existsSync, statSync } from "node:fs";

const budgets = [
  { path: "web/dist/main.js", max: 1_900_000 },
  { path: "web/dist/app.css", max: 65_536 },
] as const;

let failed = false;
for (const budget of budgets) {
  const size = statSync(budget.path).size;
  console.log(`${budget.path}: ${size} / ${budget.max} bytes`);
  if (size > budget.max) {
    console.error(`${budget.path} exceeds its regression budget by ${size - budget.max} bytes`);
    failed = true;
  }
}

const archives = existsSync("dist") ? [...new Bun.Glob("orch-server-*.{tar.gz,zip}").scanSync("dist")] : [];
for (const name of archives) {
  const path = `dist/${name}`;
  const size = statSync(path).size;
  const max = 160 * 1024 * 1024;
  console.log(`${path}: ${size} / ${max} bytes`);
  if (size > max) {
    console.error(`${path} exceeds its release archive budget by ${size - max} bytes`);
    failed = true;
  }
}

if (failed) process.exit(1);
