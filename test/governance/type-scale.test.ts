import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cn } from "../../web/src/ui/cn.ts";

/**
 * One owner for the type scale: `@theme`, never a rem literal at a call site.
 *
 * Colour and family were tokens from the start; size was not, so it grew to
 * eleven values over 262 call sites while `docs/design/ui.md` described seven.
 * Both were honest and neither could be checked. A literal here is how the
 * twelfth appears.
 */

const files = (dir: string): string[] => {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(path));
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
};

test("no font size is written as a literal; they come from the theme", () => {
  const scanned = [...files("web/src"), ...files("test/web")];
  // A scan that finds nothing passes for the same reason it exists to catch.
  expect(scanned.length).toBeGreaterThan(40);

  const offenders = scanned.flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(/text-\[[0-9.]+(?:rem|px|em)\]/g)].map((m) => `${path}: ${m[0]}`),
  );
  expect(offenders).toEqual([]);
});

test("every named size is defined once, in the theme", () => {
  const theme = readFileSync("web/style.css", "utf8");
  const declared = [...theme.matchAll(/--text-([a-z]+):\s*([0-9.]+rem)/g)].map((m) => m[1]!);
  expect(new Set(declared).size).toBe(declared.length);
  // The scale `docs/design/ui.md` documents, in full.
  expect(declared.sort()).toEqual(
    ["base", "body", "card", "figure", "lead", "meta", "name", "pill", "secondary", "tag", "title"].sort(),
  );

  const doc = readFileSync("docs/design/ui.md", "utf8");
  for (const name of declared) expect(doc, `ui.md does not document text-${name}`).toContain(`\`text-${name}\``);
});

test("a size and a colour survive each other, and the merger knows every token", () => {
  // `tailwind-merge` groups by prefix, so a name it has not been told about under
  // `text-` is filed as a colour. `text-meta` and `text-ink` then looked like two
  // colours, the later one won, and the flame graph's labels lost their size the
  // moment the scale stopped being a rem literal the merger could read. Nothing
  // threw; the labels were simply 16px again.
  expect(cn("text-meta", "text-ink")).toBe("text-meta text-ink");
  expect(cn("text-ink", "text-meta")).toBe("text-ink text-meta");
  // And a size still replaces a size, which is the whole reason `cn` exists.
  expect(cn("text-meta", "text-title")).toBe("text-title");

  // Every token in the theme, or the next one added is a colour again.
  const declared = [...readFileSync("web/style.css", "utf8").matchAll(/--text-([a-z]+):\s*[0-9.]+rem/g)].map(
    (m) => m[1]!,
  );
  for (const name of declared) {
    expect(cn(`text-${name}`, "text-ink"), `text-${name} is not in cn.ts's font-size group`).toBe(
      `text-${name} text-ink`,
    );
  }
});
