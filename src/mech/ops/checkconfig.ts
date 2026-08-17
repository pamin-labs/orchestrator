import { keysUnder, schemaAt } from "../../contracts/config.ts";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULTS_FOR_CHECK, type Config } from "../../config.ts";
import type { RoleDef } from "../../config.ts";
import { JsonObject, type Json } from "../../contracts/json.ts";
import { errText } from "../util/text.ts";
import type { z } from "zod";

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

type JsonMap = z.infer<typeof JsonObject>;

const isMap = (value: Json): value is JsonMap => value !== null && typeof value === "object" && !Array.isArray(value);

/** `maxGroup` for `maxGroups`. Containment, not edit distance: typos here are dropped or doubled characters, and a Levenshtein for that is thirty lines nobody reads. */
const nearest = (key: string, legal: string[]): string | null => {
  const k = key.toLowerCase();
  return legal.find((c) => c.toLowerCase().includes(k) || k.includes(c.toLowerCase())) ?? null;
};

/**
 * Check the yaml against `ConfigSchema`, key by key.
 *
 * Key by key rather than one `ConfigSchema.parse(parsed)`, and for two reasons a
 * whole-document parse cannot give: the yaml is a *partial* override, so absent
 * keys are correct and `.parse` would demand them; and an unknown key deserves
 * the "did you mean" that made this checker worth having — zod can say a key is
 * unrecognised but not which real key it looks like.
 *
 * What is no longer here is the type table. `kind()`, `POSITIVE` and `UNIONS`
 * were a second opinion about what a legal config is, and the panel had a third
 * — which is how `maxGroups: 0` came to be refused in the file and accepted over
 * HTTP.
 */
function walk(parsed: JsonMap, at: string, out: Finding[]): void {
  const siblings = keysUnder(at);
  for (const [k, v] of Object.entries(parsed)) {
    const key = at ? `${at}.${k}` : k;
    const schema = schemaAt(key);
    if (!schema) {
      const near = nearest(k, siblings);
      out.push({
        level: "warn",
        key,
        says: near ? `没这个键，是不是 ${at ? `${at}.` : ""}${near}` : "没这个键，被忽略了",
      });
      continue;
    }
    if (v === null || v === undefined) {
      out.push({ level: "warn", key, says: "空的，用默认值" });
      continue;
    }
    // A block the schema enumerates is walked so its own keys get the same
    // treatment. A record is a leaf: its keys are model ids and mount points.
    if (isMap(v) && keysUnder(key).length) {
      walk(v, key, out);
      continue;
    }
    const r = schema.safeParse(v);
    if (!r.success) out.push({ level: "fatal", key, says: r.error.issues.map((i) => i.message).join("；") });
  }
}

export function checkConfig(path: string): { findings: Finding[]; overridden: number } {
  if (!existsSync(path)) {
    return { findings: [{ level: "warn", key: path, says: "没有这个文件，全用默认值" }], overridden: 0 };
  }
  let parsed: JsonMap;
  try {
    const result = JsonObject.safeParse(Bun.YAML.parse(readFileSync(path, "utf8")));
    if (!result.success) return { findings: [], overridden: 0 };
    parsed = result.data;
  } catch (e) {
    return { findings: [{ level: "fatal", key: path, says: `读不了：${errText(e)}` }], overridden: 0 };
  }
  const findings: Finding[] = [];
  walk(parsed, "", findings);
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
  const base = JsonObject.parse(DEFAULTS_FOR_CHECK);
  return Object.entries(cfg).filter(
    // dataDir is resolved to an absolute path on the way in, so it never equals
    // the default and is not something the boss wrote.
    ([k, v]) => k !== "dataDir" && JSON.stringify(v) !== JSON.stringify(base[k]),
  ).length;
}
