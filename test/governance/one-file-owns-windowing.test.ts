import { expect, test } from "bun:test";

/**
 * The virtualizer has one importer, so swapping it is one file.
 *
 * Four lists were each capped to a literal because nothing windowed them. The
 * fix is a dependency, and a dependency spread across four call sites is four
 * places to re-learn `measureElement`, four copies of the stick-to-bottom rule —
 * which is how `Bootstrap` and `Workspace` came to disagree about it — and four
 * files to touch when the library moves. `web/src/ui/virtual-list.tsx` owns it;
 * everything else takes `items` and a row.
 */
const OWNER = "web/src/ui/virtual-list.tsx";
const LIBRARY = ["@tanstack", "react-virtual"].join("/");

test("one file imports the virtualizer", async () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "web", "src"], { stdout: "pipe", stderr: "pipe" });
  expect(listed.exitCode).toBe(0);

  const importers: string[] = [];
  for (const path of listed.stdout.toString().split("\0").filter(Boolean)) {
    if (path === OWNER) continue;
    const file = Bun.file(path);
    if (!(await file.exists()) || file.type.startsWith("image/")) continue;
    if ((await file.text()).includes(LIBRARY)) importers.push(path);
  }

  expect(importers).toEqual([]);
});
