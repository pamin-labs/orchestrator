import type { DB } from "./db.ts";
import { DEFAULTS_FOR_CHECK as DEFAULTS, type Config } from "./config.ts";
import {
  ConfigSchema,
  isSettingPath,
  paths,
  renderType,
  settingSchema,
  SettingWriteSchema,
  type SettingPath,
  type SettingValue,
  type SettingWrite,
} from "./config-schema.ts";
import { JsonObject, JsonValue, type Json } from "./contracts/json.ts";

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
export function settablePaths(): Map<SettingPath, string> {
  const out = new Map<SettingPath, string>();
  for (const [path, schema] of paths()) if (isSettingPath(path)) out.set(path, renderType(schema));
  return out;
}

/** Why this path may not be set to this value, or null if it may. */
export function refuse(path: string, value: Json): string | null {
  const parsed = SettingWriteSchema.safeParse({ path, value });
  if (parsed.success) return null;
  const message = parsed.error.issues.map((issue) => issue.message).join("; ");
  return message.startsWith("no setting called ") ? message : `${path}: ${message}`;
}

function read(db: DB): SettingWrite[] {
  const out: SettingWrite[] = [];
  for (const r of db.query<{ k: string; v: string }, []>("SELECT k, v FROM setting").all()) {
    if (!r.k.startsWith(PREFIX)) continue;
    try {
      const value: unknown = JSON.parse(r.v);
      const write = SettingWriteSchema.safeParse({ path: r.k.slice(PREFIX.length), value });
      if (write.success && write.data.value !== null) out.push(write.data);
    } catch {}
  }
  return out;
}

/** What the panel shows: only the paths that actually have an override. */
export function overrides(db: DB): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const { path, value } of read(db)) if (value !== null) out[path] = JsonValue.parse(value);
  return out;
}

function assign(cfg: Config, path: SettingPath, value: Json): void {
  const root = JsonObject.parse(structuredClone(cfg));
  const parts = path.split(".");
  let node = root;
  for (const p of parts.slice(0, -1)) {
    const next = node[p];
    if (!next || Array.isArray(next) || typeof next !== "object")
      throw new Error(`setting path is not an object: ${path}`);
    node = next;
  }
  node[parts.at(-1)!] = value;
  Object.assign(cfg, ConfigSchema.parse(root));
}

/** Overlay the stored overrides onto the config object. Mutates, at boot. */
export function applyOverrides(db: DB, cfg: Config): Config {
  for (const { path, value } of read(db)) if (value !== null) assign(cfg, path, JsonValue.parse(value));
  return cfg;
}

/**
 * Write one setting and make it true immediately.
 *
 * Both halves, always: the row is what survives a restart, and the mutation is
 * what the running fleet reads. Doing only the first is the shape of a knob that
 * reads back as itself and changes nothing until tomorrow.
 */
export function putSetting<P extends SettingPath>(
  db: DB,
  cfg: Config,
  path: P,
  value: SettingValue<P> | null,
): string | null {
  const parsed = SettingWriteSchema.safeParse({ path, value });
  if (!parsed.success) return `${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`;
  if (parsed.data.value === null) {
    db.run("DELETE FROM setting WHERE k = ?", [PREFIX + path]);
    // Back to whatever the file said. Re-reading it would mean re-running the
    // env overrides too, so the default comes from the same table the panel
    // shows as "default".
    assign(cfg, path, JsonValue.parse(defaultFor(path)));
    return null;
  }
  db.run("INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [
    PREFIX + path,
    JSON.stringify(parsed.data.value),
  ]);
  assign(cfg, path, JsonValue.parse(parsed.data.value));
  return null;
}

const jsonAt = (root: Json, path: SettingPath): Json => {
  let node = root;
  for (const part of path.split(".")) {
    if (!node || Array.isArray(node) || typeof node !== "object" || !(part in node)) {
      throw new Error(`setting path is missing: ${path}`);
    }
    node = node[part]!;
  }
  return node;
};

// TypeScript widens a schema selected by a generic dotted path to all leaf
// outputs; each assertion stays on the same line as the path-specific parse.
export function defaultFor<P extends SettingPath>(path: P): SettingValue<P> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- settingSchema(path) validates the generic path-specific output
  return settingSchema(path).parse(jsonAt(JsonValue.parse(DEFAULTS), path)) as SettingValue<P>;
}

export function currentFor<P extends SettingPath>(cfg: Config, path: P): SettingValue<P> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- settingSchema(path) validates the generic path-specific output
  return settingSchema(path).parse(jsonAt(JsonValue.parse(cfg), path)) as SettingValue<P>;
}
