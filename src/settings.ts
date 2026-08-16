import type { DB } from "./db.ts";
import { DEFAULTS_FOR_CHECK as DEFAULTS, type Config } from "./config.ts";
import { paths, renderType } from "./config-schema.ts";
import type { z } from "zod";

/**
 * Settings the boss changes in the panel, layered over the file.
 *
 * `config/default.yaml` is where the fleet is *installed* — which interface to
 * listen on, which port, where the database lives. Everything else is an
 * operating decision the boss makes while watching the thing run, and editing a
 * yaml inside an unpacked release to make it is the wrong shape twice over: the
 * release is not a config directory, and a restart to change a concurrency limit
 * costs more than the change.
 *
 * So the file supplies defaults and this supplies overrides, which is the
 * arrangement `sandbox_image` and `sandbox_server_addr` have already been using.
 * The keys are dotted paths into `Config` (`maxGroups`, `sandbox.memory`) and
 * `DEFAULTS` is the authority on which exist and what type each one is — one
 * table, so a key cannot be settable without also being real.
 */
const PREFIX = "cfg.";

/** Paths that are not the boss's to change here, with the reason. */
const NOT_SETTABLE: Record<string, string> = {
  host: "where the server listens is a startup argument (config/default.yaml or ORCH_HOST)",
  port: "where the server listens is a startup argument (config/default.yaml or ORCH_PORT)",
  dataDir: "the database this would be stored in is the thing it configures (ORCH_DATA_DIR)",
  "sandbox.apiKey": "a secret; it goes in runtime_auth or ORCH_SANDBOX_API_KEY, never in a settings row",
};

/**
 * Which paths the panel may set, and what each one has to be.
 *
 * From `ConfigSchema`, not from a walk over `DEFAULTS`. The walk is what this
 * replaces: it read the *type of the default value*, so `maxGroups` was "a
 * number" and `0` passed — and the scheduler's admission test is
 * `busyGroups.size >= maxGroups()`, so zero stops every group turn for good,
 * persisted, across restarts. The yaml checker had the bound; this door did not,
 * and there was nothing making the two agree.
 */
export function settablePaths(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, schema] of settableSchemas()) out.set(path, renderType(schema));
  return out;
}

/** The same paths, with the schema that judges a write rather than a render hint. */
function settableSchemas(): Map<string, z.ZodType> {
  const all = paths();
  for (const k of Object.keys(NOT_SETTABLE)) all.delete(k);
  return all;
}

/** Why this path may not be set to this value, or null if it may. */
export function refuse(path: string, value: unknown): string | null {
  if (NOT_SETTABLE[path]) return NOT_SETTABLE[path]!;
  const schema = settableSchemas().get(path);
  if (!schema) return `no setting called ${path}`;
  if (value === null) return null; // clearing an override is always allowed
  const r = schema.safeParse(value);
  // Prefixed with the path, because this reaches the boss as a toast with no
  // other context — "expected number, received string" beside eight other rows
  // does not say which row.
  return r.success ? null : `${path}: ${r.error.issues.map((i) => i.message).join("; ")}`;
}

function read(db: DB): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const r of db.query<{ k: string; v: string }, []>("SELECT k, v FROM setting").all()) {
    if (!r.k.startsWith(PREFIX)) continue;
    try {
      out.set(r.k.slice(PREFIX.length), JSON.parse(r.v));
    } catch {}
  }
  return out;
}

/** What the panel shows: only the paths that actually have an override. */
export function overrides(db: DB): Record<string, unknown> {
  return Object.fromEntries(read(db));
}

function assign(cfg: Config, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = cfg as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) {
    if (typeof node[p] !== "object" || node[p] === null) node[p] = {};
    node = node[p] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
}

/** Overlay the stored overrides onto the config object. Mutates, at boot. */
export function applyOverrides(db: DB, cfg: Config): Config {
  for (const [path, value] of read(db)) {
    if (refuse(path, value)) continue; // a stale key from an older version
    assign(cfg, path, value);
  }
  return cfg;
}

/**
 * Write one setting and make it true immediately.
 *
 * Both halves, always: the row is what survives a restart, and the mutation is
 * what the running fleet reads. Doing only the first is the shape of a knob that
 * reads back as itself and changes nothing until tomorrow.
 */
export function putSetting(db: DB, cfg: Config, path: string, value: unknown): string | null {
  const no = refuse(path, value);
  if (no) return no;
  if (value === null) {
    db.run("DELETE FROM setting WHERE k = ?", [PREFIX + path]);
    // Back to whatever the file said. Re-reading it would mean re-running the
    // env overrides too, so the default comes from the same table the panel
    // shows as "default".
    assign(cfg, path, defaultFor(path));
    return null;
  }
  db.run("INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [
    PREFIX + path,
    JSON.stringify(value),
  ]);
  assign(cfg, path, value);
  return null;
}

export function defaultFor(path: string): unknown {
  let node: unknown = DEFAULTS;
  for (const p of path.split(".")) node = (node as Record<string, unknown>)?.[p];
  return node;
}
