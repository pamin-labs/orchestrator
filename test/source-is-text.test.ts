import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every source file is text, or its diff is unreadable.
 *
 * `src/mech/github.ts` shipped in `231bd96` with a raw NUL byte in a string
 * literal — the ETag cache key was written `` `${token}<NUL>${url}` `` instead of
 * the escape. It ran correctly, and a NUL is arguably the better separator. What
 * broke was everything that reads the file as text: git calls it binary, so
 * `git diff`, `git blame` and `git log -p` all answer "Binary files differ" and
 * nothing else. The whole `gh` → REST rewrite landed with a reviewable commit
 * message and an unreviewable diff.
 *
 * That gap is invisible by construction — the code works, the tests pass, and the
 * only symptom is a review that shows nothing. So it gets an `if`.
 */

const ROOT = new URL("../", import.meta.url).pathname;
const DIRS = ["src", "test", "web/src", "scripts"];

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

test("every source file is text, or its diff is unreadable", () => {
  const binary: string[] = [];
  for (const dir of DIRS) {
    for (const file of files(join(ROOT, dir))) {
      // Bytes, not a decoded string: a decoder is free to substitute, and the
      // question here is what git sees.
      //
      // The offset comes along because a NUL is invisible in an editor — without
      // it the next person to see this go red has to write the script this test
      // replaced in order to find the byte.
      const at = readFileSync(file).indexOf(0);
      if (at >= 0) binary.push(`${file.slice(ROOT.length)} (NUL at byte ${at})`);
    }
  }
  expect(binary).toEqual([]);
});
