/**
 * Write a generated file, saying whether it moved.
 *
 * Two scripts derive a checked-in file from `locales/*.po` and both wrote the
 * same read-compare-write; `fallow audit` found the halves as one 21-line clone.
 */
/**
 * No `--check` mode any more. It existed so preflight could say "stale" without
 * writing, and both callers are reached through `i18n:extract` now — which
 * regenerates and lets `git diff --exit-code` ask the question. A mode with no
 * caller is a mode the docs go on believing is running: the enforcement matrix
 * named `i18n:progress --check` as a CI gate for a week after CI stopped having
 * one.
 */
export async function write(target: string, next: string): Promise<void> {
  const current = await Bun.file(target)
    .text()
    .catch(() => "");
  if (next === current) {
    console.log(`${target}: unchanged`);
    return;
  }
  await Bun.write(target, next);
  console.log(`${target}: written`);
}
