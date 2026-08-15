import { existsSync, readFileSync } from "node:fs";
import { DEFAULTS_FOR_CHECK, type Config } from "../../config.ts";
import type { RoleDef } from "../../config.ts";

/**
 * Does the yaml say what it thinks it says?
 *
 * `loadConfig` is `{ ...DEFAULTS, ...parsed }` and nothing else, which fails
 * three ways and all of them silently: a misspelled key does nothing, a wrong
 * type is carried to whoever reads it, and a partial nested block replaces the
 * whole default block — write `sandbox:` with two of its eight fields and the
 * other six become `undefined`, surfacing an hour later as a container that will
 * not start. Config errors have to be reported where they were made.
 *
 * The rules come from `DEFAULTS`, not from a second table beside it: the default
 * value's type is the expected type, and its presence is the list of legal keys.
 * A table would be 28 lines that drift from the 28 they describe.
 */

export type Level = "fatal" | "warn" | "info";
export interface Finding {
  level: Level;
  /** Dotted path, as it is written in the yaml. */
  key: string;
  says: string;
}

/** Numbers that cannot be zero or negative without breaking something at boot. */
const POSITIVE = new Set([
  "port",
  "maxGroups",
  "turnTimeoutMs",
  "maxTurnsPerJob",
  "watchdogIntervalMs",
  "leaseTimeoutMs",
  "installTimeoutMs",
  "ctxBudgetChars",
]);

/**
 * Keys whose type is a union, which a default value cannot express.
 *
 * One of them, and the checker found it by calling this repo's own config
 * fatal: `leaseSlots` is one number for the whole pool or one per resource tag,
 * and the committed yaml uses the second form.
 */
const UNIONS: Record<string, string[]> = { leaseSlots: ["number", "object"] };

const kind = (v: unknown): string =>
  Array.isArray(v) ? "array" : v === null ? "null" : typeof v;

/** Plain object, as opposed to an array or a null. */
const isMap = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** `maxGroup` for `maxGroups`. Containment, not edit distance: typos here are dropped or doubled characters, and a Levenshtein for that is thirty lines nobody reads. */
const nearest = (key: string, legal: string[]): string | null => {
  const k = key.toLowerCase();
  return legal.find((c) => c.toLowerCase().includes(k) || k.includes(c.toLowerCase())) ?? null;
};

function walk(parsed: Record<string, unknown>, base: Record<string, unknown>, at: string, out: Finding[]): void {
  const legal = Object.keys(base);
  for (const [k, v] of Object.entries(parsed)) {
    const key = at ? `${at}.${k}` : k;
    if (!(k in base)) {
      const near = nearest(k, legal);
      out.push({ level: "warn", key, says: near ? `没这个键，是不是 ${at ? `${at}.` : ""}${near}` : "没这个键，被忽略了" });
      continue;
    }
    const want = base[k];
    if (v === null || v === undefined) {
      out.push({ level: "warn", key, says: "空的，用默认值" });
      continue;
    }
    const allowed = UNIONS[key] ?? [kind(want)];
    if (!allowed.includes(kind(v))) {
      out.push({ level: "fatal", key, says: `要 ${allowed.join(" 或 ")}，写的是 ${kind(v)}` });
      continue;
    }
    if (typeof v === "number" && POSITIVE.has(key) && v <= 0) {
      out.push({ level: "fatal", key, says: `要大于 0，写的是 ${v}` });
      continue;
    }
    // A map of models or windows is open-ended — its keys are model ids, not
    // config keys — so only blocks the defaults actually enumerate are walked.
    if (isMap(v) && isMap(want) && Object.keys(want).length) walk(v, want, key, out);
  }
}

export function checkConfig(path: string): { findings: Finding[]; overridden: number } {
  if (!existsSync(path)) {
    return { findings: [{ level: "warn", key: path, says: "没有这个文件，全用默认值" }], overridden: 0 };
  }
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { findings: [{ level: "fatal", key: path, says: `读不了：${(e as Error).message}` }], overridden: 0 };
  }
  if (!isMap(parsed)) return { findings: [], overridden: 0 };
  const findings: Finding[] = [];
  walk(parsed, DEFAULTS_FOR_CHECK, "", findings);
  return { findings, overridden: Object.keys(parsed).length };
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const TIERS = ["trivial", "normal", "hard"];

/**
 * A role's enums, which nothing else checks.
 *
 * `loadRoles` refuses a role with no name or no prompt and accepts everything
 * else, so `effort: highest` travels all the way to the CLI's argv and comes
 * back as a usage error attributed to the turn.
 */
export function checkRoles(roles: Map<string, RoleDef>, runtimes: string[]): Finding[] {
  const out: Finding[] = [];
  for (const [name, r] of roles) {
    if (r.effort && !EFFORTS.includes(r.effort))
      out.push({ level: "warn", key: `${name}.effort`, says: `不认识 ${r.effort}，认的是 ${EFFORTS.join("/")}` });
    if (r.tier && !TIERS.includes(r.tier))
      out.push({ level: "warn", key: `${name}.tier`, says: `不认识 ${r.tier}，认的是 ${TIERS.join("/")}` });
    if (r.runtime && !runtimes.includes(r.runtime))
      out.push({ level: "warn", key: `${name}.runtime`, says: `没有 ${r.runtime} 这个 runtime` });
  }
  return out;
}

/** What the yaml actually changed, for the one line that says so. */
export function changed(cfg: Config): number {
  // Assignable rather than cast: `Config` is a type alias, so it carries an
  // implicit index signature and this is a plain widening.
  const base: Record<string, unknown> = DEFAULTS_FOR_CHECK;
  return Object.entries(cfg).filter(
    // dataDir is resolved to an absolute path on the way in, so it never equals
    // the default and is not something the boss wrote.
    ([k, v]) => k !== "dataDir" && JSON.stringify(v) !== JSON.stringify(base[k]),
  ).length;
}
