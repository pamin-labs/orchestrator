import { existsSync, statSync } from "node:fs";

/**
 * The release archive, and nothing else.
 *
 * `web/dist/main.js` and `app.css` were capped here too, at 1,900,000 and 65,536
 * bytes. Both are gone, and the reasoning is in
 * `docs/adr/019-no-web-bundle-budget.md`: the panel is served over loopback to
 * one person, so the size of its JavaScript is not a product constraint, and a
 * ceiling nobody derived — 1.9MB against an actual 1.65MB — reported nothing
 * until something exceeded it by multiples.
 *
 * The archive is different in kind. It is downloaded and unpacked on somebody
 * else's machine, so its size is a cost a user pays.
 */
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;

let failed = false;
const archives = existsSync("dist") ? [...new Bun.Glob("orch-server-*.{tar.gz,zip}").scanSync("dist")] : [];
for (const name of archives) {
  const path = `dist/${name}`;
  const size = statSync(path).size;
  console.log(`${path}: ${size} / ${MAX_ARCHIVE_BYTES} bytes`);
  if (size > MAX_ARCHIVE_BYTES) {
    console.error(`${path} exceeds its release archive budget by ${size - MAX_ARCHIVE_BYTES} bytes`);
    failed = true;
  }
}

if (archives.length === 0) console.log("no release archive in dist/; nothing to check");

if (failed) process.exit(1);
