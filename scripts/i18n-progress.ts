import { endonymOf, LOCALES } from "../src/contracts/config.ts";
import { translations } from "./lingui-catalogs.ts";

/**
 * How much of what the orchestrator says has been translated, one bar per
 * language, written into both READMEs between markers.
 *
 * The bars are `progress-bar.xyz`, which renders a percentage as an SVG. It was
 * `inlang.com/badge` first — the service every "translation status" answer
 * points at — and that returns 404 for every repository now, including the ones
 * whose READMEs still link it. Checked before it was written down here, which is
 * the only reason this is not a third broken image.
 */
/**
 * One surface now, where there were two. `lang.ts` used to hold its own English
 * and Chinese tables and got a row of their own; those sentences are ordinary
 * panel messages since `ev.*` ids landed, so they are counted in the bars above
 * and the server renders them from the same catalogs.
 */

const MARK = { open: "<!-- i18n:table -->", close: "<!-- /i18n:table -->" };
const BAR = (percent: number) => `https://progress-bar.xyz/${percent}?width=140&suffix=%25`;

type Row = { label: string; done: number; total: number; source?: boolean };

const pct = (r: Row): number => (r.total === 0 ? 100 : Math.round((r.done / r.total) * 100));

async function panelRows(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const locale of LOCALES) {
    // Through Lingui's own reader, not by parsing `.po`: this is the count
    // `lingui extract` prints, so the README cannot disagree with the tool.
    const { messages, missing } = await translations(locale);
    const total = Object.keys(messages).length;
    // The source language needs no translations: every message falls back to the
    // English the macro hashed, so it is complete by construction rather than by
    // anybody's work.
    const done = locale === "en" ? total : total - missing.length;
    rows.push({ label: endonymOf(locale), done, total, ...(locale === "en" ? { source: true } : {}) });
  }
  return rows;
}

/** One entry per README, so the renderer below has no branches in it: the two
 *  documents differ only in their words. */
const COPY = {
  "README.md": {
    head: ["Language", "Progress", "Messages"],
    source: "source",
    panel: (n: number) => `**Panel** · ${n} messages`,
  },
  "README.zh-CN.md": {
    head: ["语言", "进度", "条数"],
    source: "源语言",
    panel: (n: number) => `**面板** · ${n} 条消息`,
  },
} as const;

type Copy = (typeof COPY)[keyof typeof COPY];

const line = (r: Row, copy: Copy): string =>
  `| ${r.label} | ![](${BAR(pct(r))}) | ${r.source ? copy.source : `${r.done} / ${r.total}`} |`;

const table = (rows: Row[], copy: Copy): string[] => [
  `| ${copy.head.join(" | ")} |`,
  "| --- | --- | ---: |",
  ...rows.map((r) => line(r, copy)),
  "",
];

const block = (rows: Row[], copy: Copy): string =>
  [MARK.open, copy.panel(rows[0]?.total ?? 0), "", ...table(rows, copy), MARK.close].join("\n");

function splice(doc: string, next: string): string {
  const from = doc.indexOf(MARK.open);
  const to = doc.indexOf(MARK.close);
  if (from === -1 || to === -1) throw new Error(`no ${MARK.open} … ${MARK.close} block to write into`);
  return doc.slice(0, from) + next + doc.slice(to + MARK.close.length);
}

const check = process.argv.includes("--check");
const panel = await panelRows();
let stale = false;

for (const [doc, copy] of Object.entries(COPY)) {
  const current = await Bun.file(doc).text();
  const next = splice(current, block(panel, copy));
  if (next === current) continue;
  if (check) {
    console.error(`${doc}: translation progress is stale — run \`bun run i18n:progress\``);
    stale = true;
    continue;
  }
  await Bun.write(doc, next);
  console.log(`${doc}: updated`);
}

if (stale) process.exit(1);
if (!check)
  for (const r of panel) console.log(`${r.label.padEnd(10)} ${String(pct(r)).padStart(3)}%  ${r.done}/${r.total}`);
