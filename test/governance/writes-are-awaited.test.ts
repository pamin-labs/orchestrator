import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

/**
 * A Drizzle write nobody awaits does not happen.
 *
 * The builder is a lazy thenable, not a promise: TypeScript sees a value, and
 * `no-floating-promises` sees nothing at all, because there is no promise to
 * float. Measured — a dropped `insert` produced no error from tsc, no error from
 * oxlint, and zero rows. That makes this the one class the async conversion can
 * introduce with nothing to catch it, so it is caught here.
 */
const WRITE = /(?<![\w$])(?:\w+\.)*(?:db|tx|orm|on)\.(insert|update|delete|execute)\s*\(/;

/** A statement whose result goes somewhere is not dropped. */
const CONSUMED = /(?:^|[\s(=,:[])(?:await|return|void|yield)\s*$|[=(,[]\s*$|\.\s*$|=>\s*$/;

const dropped = (path: string): string[] => {
  const lines = readFileSync(path, "utf8").split("\n");
  return lines.flatMap((line, i) => {
    const hit = WRITE.exec(line);
    if (!hit) return [];
    const before = line.slice(0, hit.index);
    // Continued from the line above — the consumer is up there, not here.
    const previous = lines[i - 1]?.trimEnd() ?? "";
    if (CONSUMED.test(before) || CONSUMED.test(previous)) return [];
    return [`${path}:${i + 1}  ${line.trim().slice(0, 80)}`];
  });
};

test("every database write in src is awaited, returned, or assigned", () => {
  const offenders = [...new Glob("src/**/*.ts").scanSync(".")].flatMap(dropped);
  expect(offenders).toEqual([]);
});

test("every database write in the test suite is awaited, returned, or assigned", () => {
  const offenders = [...new Glob("test/**/*.ts").scanSync(".")]
    .filter((p) => !p.endsWith("writes-are-awaited.test.ts"))
    .flatMap(dropped);
  expect(offenders).toEqual([]);
});

/**
 * `max()` is never applied to a `bigint` column.
 *
 * Drizzle renders it `max("at")::text` so the value keeps its precision in JS.
 * Selected that is right; compared it orders timestamps as digit strings, and
 * beside a `bigint` it is a 42883 with no operator at all. Both shipped — the
 * panel's draft cards threw and the watchdog's staleness rule was wrong. `maxMs`
 * in schema.ts is the one that does not cast.
 */
test("no aggregate casts a timestamp to text behind the caller's back", () => {
  const bigints = new Set(
    [...readFileSync("src/platform/persistence/schema.ts", "utf8").matchAll(/^\s+(\w+): bigint\(/gm)].map(
      (m) => m[1] ?? "",
    ),
  );
  const offenders = [...new Glob("src/**/*.ts").scanSync(".")].flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, i) => {
        const hit = /\b(?:max|min)\((\w+)\.(\w+)\)/.exec(line);
        return hit && bigints.has(hit[2] ?? "") ? [`${path}:${i + 1}  ${hit[0]}`] : [];
      }),
  );
  expect(offenders).toEqual([]);
});

/**
 * No aggregate reaches JSON as a BigInt.
 *
 * `count()` and `maxMs` map their result to a number, but wrapping either in an
 * outer `sql` template drops that — the outer expression has its own mapping and
 * the default for `bigint` is a JS BigInt. `JSON.stringify` throws on one, so the
 * panel answers 500 with a message about serialization and nothing about which
 * column. Measured: it did, on the state snapshot.
 */
test("an aggregate wrapped in a sql template maps its result back to a number", () => {
  const offenders = [...new Glob("src/**/*.ts").scanSync(".")].flatMap((path) => {
    const text = readFileSync(path, "utf8");
    // Only templates that wrap an aggregate: a plain column keeps whatever
    // mapping its own definition gave it, and flagging those would be noise that
    // gets suppressed — after which the guard stops guarding anything.
    return [...text.matchAll(/sql<[^>]*>`\(\$\{(?<body>[\s\S]*?)`(?<tail>[^\n;]*)/g)]
      .filter((hit) => /\b(count|sum|avg|maxMs|minMs)\(/.test(hit.groups?.body ?? ""))
      .filter((hit) => !hit.groups?.tail?.includes("mapWith"))
      .map((hit) => `${path}:${text.slice(0, hit.index).split("\n").length}`);
  });
  expect(offenders).toEqual([]);
});

/**
 * No JSON document is encoded twice on its way into a `jsonb` column.
 *
 * The driver encodes a parameter bound against `jsonb`, so `JSON.stringify(x)`
 * before it stores a jsonb *string* of the document rather than the document.
 * Nothing errors: `@>` then matches no row and a panel shows an empty list, and
 * `jsonb_set` writes a quoted string where an object belongs. Both shipped.
 * `to_jsonb(...)` and `jsonb_build_object(...)` are what Postgres offers instead.
 */
test("no jsonb parameter is pre-encoded with JSON.stringify", () => {
  const offenders = [...new Glob("src/**/*.ts").scanSync(".")].flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, i) =>
        // Only inside SQL: the same call in a message template is prose, and a
        // guard that flags prose is one somebody switches off.
        /\$\{JSON\.stringify\(/.test(line) && /(?:sql`|::jsonb)/.test(line)
          ? [`${path}:${i + 1}  ${line.trim().slice(0, 70)}`]
          : [],
      ),
  );
  expect(offenders).toEqual([]);
});
