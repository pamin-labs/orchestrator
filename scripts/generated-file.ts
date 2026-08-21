/**
 * Write a generated file, or check that the one on disk is what we would write.
 *
 * Two scripts derive a checked-in file from `locales/*.po`, and both
 * need the same `--check` so preflight can say "stale" instead of a reviewer
 * noticing. Shared because it was copied first: `fallow audit` found the two
 * halves as one 21-line clone.
 */
export async function writeOrCheck(target: string, next: string, source: string, script: string): Promise<void> {
  const current = await Bun.file(target)
    .text()
    .catch(() => "");
  if (process.argv.includes("--check")) {
    if (next === current) {
      console.log(`${target}: up to date`);
      return;
    }
    console.error(`${target} does not match ${source} — run \`bun run ${script}\``);
    process.exit(1);
  }
  if (next === current) console.log(`${target}: unchanged`);
  else {
    await Bun.write(target, next);
    console.log(`${target}: written`);
  }
}
