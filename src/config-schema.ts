import { z } from "zod";

/**
 * What a legal config is, in one place.
 *
 * There were two answers to that question and they disagreed. `checkconfig.ts`
 * walked `DEFAULTS` at boot with its own `kind()` plus a `POSITIVE` set and a
 * `UNIONS` table; `settings.ts` walked the same defaults for the panel and
 * checked `typeof` only. The panel was the weaker one, and the gap was not
 * cosmetic: `POST /api/v1/settings {path: "maxGroups", value: 0}` was accepted, and
 * the scheduler's admission test is `busyGroups.size >= maxGroups()` — so zero
 * means no group turn is ever dispatched again. Silently, and the override is
 * persisted, so a restart does not clear it.
 *
 * One schema, consumed by both. A bound that exists here cannot be missing from
 * one of the two doors.
 */

/** A positive whole number of milliseconds, tokens, slots, rounds. */
const count = z.number().int().positive();

/** `2` is one pool that size; a map is one pool per resource tag. */
const LeaseSlots = z.union([count, z.record(z.string(), count)]);

const ModelRef = z.object({ runtime: z.string().min(1), model: z.string() });

/** The six values that become an OpenSandbox request. */
const SandboxSpecSchema = z.object({
  image: z.string(),
  /** Kubernetes-style quantities, e.g. "4" and "8Gi". */
  cpu: z.string(),
  memory: z.string(),
  ttlSeconds: count,
  /**
   * Domains the group may not reach. Everything else is open.
   *
   * The real tokens never enter the sandbox, and an allowlist cannot enumerate
   * every registry, docs site and package a project needs. Measured in decision
   * 005: credential injection still works with defaultAction allow, so blocking
   * selected destinations costs nothing in credential safety.
   */
  denyDomains: z.array(z.string()),
  /**
   * Container mount path -> host package-cache path.
   *
   * Package caches only, and off by default. Sharing node_modules caused
   * concurrent installs to fail with EEXIST; content-addressed package caches are
   * built for concurrent readers. The sandbox server must allow every host path.
   */
  cacheDirs: z.record(z.string(), z.string()),
});

export type SandboxSpec = z.infer<typeof SandboxSpecSchema>;

/** A project's per-sandbox differences, never the server credential. */
export const SandboxOverrideSchema = SandboxSpecSchema.partial().strict();

/** Project-local config persisted in `project.config_json`. */
export const StoredProjectConfigSchema = z
  .object({
    detected: z.boolean().optional(),
    gates: z.array(z.string()).optional(),
    install: z.string().nullable().optional(),
    shared: z.array(z.string()).optional(),
    sandbox: SandboxOverrideSchema.optional(),
    index: z
      .object({ exclude: z.array(z.string()).optional() })
      .strict()
      .optional(),
  })
  // Preserve keys owned by newer releases while validating every known key.
  .catchall(z.json());

export type StoredProjectConfig = z.infer<typeof StoredProjectConfigSchema>;

export const ConfigSchema = z.object({
  language: z.string().min(1),
  maxGroups: count,
  /** One number for the whole Runner pool, or one pool per resource tag. */
  leaseSlots: LeaseSlots,
  /** Boss routes have no remote auth. The process may only listen on loopback. */
  host: z.enum(["127.0.0.1", "localhost", "::1"]),
  port: z.number().int().min(1).max(65535),
  /** provider -> difficulty -> model. One knob per family; adding one is a yaml block. */
  difficultyModel: z.record(z.string(), z.record(z.string(), z.string())),
  turnTimeoutMs: count,
  maxTurnsPerJob: count,
  // A fraction of the context window, so 0 and 1 are both meaningless: at 0 every
  // turn rotates, at 1 the session is never rotated until it overflows.
  sessionRotateFraction: z.number().gt(0).lt(1),
  /** Unread events past this get compressed by the Librarian instead of dribbling. */
  unreadDigestThreshold: count,
  /** The same complaint this many times becomes a project rule. */
  feedbackSedimentThreshold: count,
  ctxBudgetChars: count,
  /**
   * Forward every notification to a URL, as JSON. Empty means nobody but the panel.
   *
   * One field rather than an integration per service. Whatever is on the other
   * end — ntfy, Bark, a group bot, something written this afternoon — takes a
   * POST, and building a menu of five would be five things to keep working for a
   * feature whose default is off.
   */
  notifyWebhook: z.string(),
  parkAfterPausedMs: count,
  watchdogIntervalMs: count,
  // Zero is meaningful here: it means "do not retry", which is a choice.
  gateRetries: z.number().int().min(0),
  /** Wall clock for one leased command. A big compile is hours, not minutes. */
  leaseTimeoutMs: count,
  /**
   * Wall clock for installing a project's dependencies.
   *
   * The same class of thing as a lease, so the same order of magnitude. It was
   * 15 minutes, which is fine for this repo and wrong for the projects that
   * need the headroom: a monorepo's pnpm install, pip building numpy from
   * source, dotnet restore on a large solution. Too short fails as "this
   * project is broken" rather than as "that took longer than allowed", and the
   * group is blocked either way — so the default is generous and the install is
   * streamed, which is what makes a long one watchable instead of silent.
   */
  installTimeoutMs: count,
  /** Start the next slice when QA passes, without waiting for the boss to accept. */
  autoAdvance: z.boolean(),
  /** Difficulty tags accepted automatically once all three gates pass. */
  autoAcceptTiers: z.array(z.string()),
  /**
   * Token cap written onto every new slice. difficulty -> cap.
   *
   * Until this existed `budget_tokens` was never INSERTed, so it was NULL on every
   * row and the two admission checks in scheduler.ts had never stopped anything.
   * It matters more now: QA moved to a CLI with no tool whitelist, and a budget is
   * the deterministic replacement for the whitelist that used to bound its reading.
   */
  sliceBudgetTokens: z.record(z.string(), count),
  /**
   * Who answers `orch ctx query` and writes the index summaries.
   *
   * The most frequent model call in the system and pure summarisation — no
   * decision, no tools, no blackboard — so it is the first thing that should come
   * off the expensive subscription.
   */
  indexModel: ModelRef,
  /**
   * model -> context window, and a `default` for anything unlisted.
   *
   * The rotation ceiling was the literal 200_000 for every model, which is only
   * true of the cheapest one. Read off real turn logs: haiku-4-5 reports 200k,
   * sonnet-5 and opus-5 report 1M, and codex's token_count reports 272k for the
   * gpt-5.6 family. So the strong models were rotating at 120k of a 1M window —
   * five times too early, and a rotation throws the cached prefix away.
   *
   * Both CLIs report their real window during a turn, and that value wins over
   * this table; this is what the first turn of a session has to go on.
   */
  contextWindow: z.record(z.string(), count),
  /**
   * One sandbox per group — the write boundary (docs/adr/005).
   *
   * `cpu` empty means a quarter of the host's cores; the SDK's own default of
   * "1" made this repo's typecheck 3.7x slower than the host. Per-project
   * overrides live in `project.config_json.sandbox`.
   */
  sandbox: SandboxSpecSchema.extend({
    server: z.string().min(1),
    apiKey: z.string(),
  }),
  dataDir: z.string().min(1),
  /**
   * Where the ticked skills are staged for the sandboxes to mount.
   *
   * Not under `dataDir`: the sandbox server only mounts host paths on its own
   * `allowed_host_paths` allowlist, and a repo checkout is never on it. Its
   * default list is `/var/tmp/orch-cache`, which is where this pointed.
   *
   * **Under `$HOME` on macOS, and that is not cosmetic.** Docker there runs in a
   * VM, and `/var/tmp` inside the VM is the VM's own — so binding it *succeeds*
   * and hands the container an empty directory. Measured: 179 skills on the host,
   * `ls` inside the container returns 0, and the mount reports
   * `lowerdir=/`. Every agent on this machine had been running with no skills at
   * all since 006, and nothing could say so — `skillMounts` returned two correct
   * mounts, creation succeeded, and preflight counted the files on the host,
   * which is the one place they certainly are.
   *
   * Changing it means the sandbox server's `allowed_host_paths` has to name the
   * new path too. That failure is loud (creation is refused and the message names
   * the path), which is the whole reason this is worth moving: a path the runtime
   * cannot reach fails silently, a path the server has not allowed does not.
   */
  skillsDir: z.string().min(1),
});

export type DottedSchemaPath<S extends z.ZodType> =
  S extends z.ZodObject<infer Shape>
    ? {
        [K in keyof Shape & string]: Shape[K] extends z.ZodObject ? `${K}.${DottedSchemaPath<Shape[K]>}` : K;
      }[keyof Shape & string]
    : never;

export type SchemaAtPath<S extends z.ZodType, P extends string> =
  S extends z.ZodObject<infer Shape>
    ? P extends `${infer Head}.${infer Tail}`
      ? Head extends keyof Shape
        ? Shape[Head] extends z.ZodType
          ? SchemaAtPath<Shape[Head], Tail>
          : never
        : never
      : P extends keyof Shape
        ? Shape[P]
        : never
    : never;

/** Paths that belong to installation or secret storage, not the live settings table. */
const SETTING_DENIALS = {
  host: "where the server listens is a startup argument (config/default.yaml or ORCH_HOST)",
  port: "where the server listens is a startup argument (config/default.yaml or ORCH_PORT)",
  dataDir: "the database this would be stored in is the thing it configures (ORCH_DATA_DIR)",
  "sandbox.apiKey": "a secret; it goes in runtime_auth or ORCH_SANDBOX_API_KEY, never in a settings row",
} as const;

export type ConfigPath = DottedSchemaPath<typeof ConfigSchema>;
export type SettingPath = Exclude<ConfigPath, keyof typeof SETTING_DENIALS>;
export type SettingValue<P extends SettingPath> = z.output<SchemaAtPath<typeof ConfigSchema, P>>;
export type SettingWrite = {
  [P in SettingPath]: { path: P; value: SettingValue<P> | null };
}[SettingPath];

/**
 * The schema for one dotted path, or null if there is no such setting.
 *
 * Walks into object schemas only. A `z.record` is a leaf on purpose:
 * `contextWindow` is keyed by model id and `cacheDirs` by mount point, so their
 * keys are data and the whole map is the value being set.
 */
export function schemaAt<P extends ConfigPath>(path: P): SchemaAtPath<typeof ConfigSchema, P>;
export function schemaAt(path: string): z.ZodType | null;
export function schemaAt(path: string): z.ZodType | null {
  let node: z.ZodType = ConfigSchema;
  for (const key of path.split(".")) {
    if (!(node instanceof z.ZodObject)) return null;
    const next = (node.shape as Record<string, z.ZodType>)[key];
    if (!next) return null;
    node = next;
  }
  return node;
}

/** The schema for a live setting, excluding installation and secret paths. */
export function settingSchema<P extends SettingPath>(path: P): SchemaAtPath<typeof ConfigSchema, P>;
export function settingSchema(path: string): z.ZodType | null;
export function settingSchema(path: string): z.ZodType | null {
  return path in SETTING_DENIALS ? null : schemaAt(path);
}

export const isSettingPath = (path: string): path is SettingPath => settingSchema(path) !== null;

const SettingInput = z.object({ path: z.string().min(1).max(120), value: z.json() });

/**
 * One path/value write, with both its RPC type and runtime check derived from ConfigSchema.
 *
 * The assertion is the only bridge TypeScript needs: runtime strings cannot preserve
 * which Map entry supplied which schema. The transform proves that relationship before
 * producing SettingWrite; every HTTP, database and browser write uses this same schema.
 */
export const SettingWriteSchema = SettingInput.transform((input, ctx): SettingWrite => {
  const denied = SETTING_DENIALS[input.path as keyof typeof SETTING_DENIALS];
  if (denied) {
    ctx.addIssue({ code: "custom", path: ["path"], message: denied });
    return z.NEVER;
  }
  const schema = settingSchema(input.path);
  if (!schema) {
    ctx.addIssue({ code: "custom", path: ["path"], message: `no setting called ${input.path}` });
    return z.NEVER;
  }
  if (input.value !== null) {
    const parsed = schema.safeParse(input.value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ["value", ...issue.path] });
      return z.NEVER;
    }
  }
  return input as SettingWrite;
}) as z.ZodType<SettingWrite, SettingWrite>;

/** Every settable dotted path, with the schema that judges it. */
export function paths(node: z.ZodType = ConfigSchema, prefix = ""): Map<string, z.ZodType> {
  const out = new Map<string, z.ZodType>();
  if (!(node instanceof z.ZodObject)) return out;
  for (const [k, v] of Object.entries<z.ZodType>(node.shape)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v instanceof z.ZodObject) for (const [q, w] of paths(v, p)) out.set(q, w);
    else out.set(p, v);
  }
  return out;
}

/**
 * How the panel should draw this setting: a box, a switch, a list, a table.
 *
 * Derived from the schema rather than from the type of the default value, which
 * is what it used to be — and which is why `maxGroups: 0` passed the panel while
 * failing the yaml checker. A `record` renders as a table because its keys are
 * data (model ids, mount points); `leaseSlots` is a number-or-table union and
 * the table is the form the shipped config uses.
 */
export function renderType(schema: z.ZodType): string {
  const t = schema.def.type;
  if (t === "record") return "object";
  if (t === "union") return "object";
  return t;
}

/** The keys a block enumerates, or none if it is a leaf or an open map. */
export function keysUnder(prefix: string): string[] {
  const node = prefix ? schemaAt(prefix) : ConfigSchema;
  return node instanceof z.ZodObject ? Object.keys(node.shape) : [];
}
