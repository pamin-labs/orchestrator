import { z } from "zod";

/**
 * What a legal config is, in one place.
 *
 * There were two answers to that question and they disagreed. `checkconfig.ts`
 * walked `DEFAULTS` at boot with its own `kind()` plus a `POSITIVE` set and a
 * `UNIONS` table; `settings.ts` walked the same defaults for the panel and
 * checked `typeof` only. The panel was the weaker one, and the gap was not
 * cosmetic: `POST /api/settings {path: "maxGroups", value: 0}` was accepted, and
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

export const ConfigSchema = z.object({
  language: z.string().min(1),
  maxGroups: count,
  leaseSlots: LeaseSlots,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  difficultyModel: z.record(z.string(), z.record(z.string(), z.string())),
  turnTimeoutMs: count,
  maxTurnsPerJob: count,
  // A fraction of the context window, so 0 and 1 are both meaningless: at 0 every
  // turn rotates, at 1 the session is never rotated until it overflows.
  sessionRotateFraction: z.number().gt(0).lt(1),
  unreadDigestThreshold: count,
  feedbackSedimentThreshold: count,
  ctxBudgetChars: count,
  notifyWebhook: z.string(),
  parkAfterPausedMs: count,
  watchdogIntervalMs: count,
  // Zero is meaningful here: it means "do not retry", which is a choice.
  gateRetries: z.number().int().min(0),
  leaseTimeoutMs: count,
  installTimeoutMs: count,
  autoAdvance: z.boolean(),
  autoAcceptTiers: z.array(z.string()),
  sliceBudgetTokens: z.record(z.string(), count),
  indexModel: ModelRef,
  contextWindow: z.record(z.string(), count),
  sandbox: z.object({
    server: z.string().min(1),
    apiKey: z.string(),
    image: z.string(),
    cpu: z.string(),
    memory: z.string(),
    ttlSeconds: count,
    denyDomains: z.array(z.string()),
    /** mount path -> host path, shared by every sandbox. Package caches only. */
    cacheDirs: z.record(z.string(), z.string()),
  }),
  dataDir: z.string().min(1),
  skillsDir: z.string().min(1),
});

/**
 * The schema for one dotted path, or null if there is no such setting.
 *
 * Walks into object schemas only. A `z.record` is a leaf on purpose:
 * `contextWindow` is keyed by model id and `cacheDirs` by mount point, so their
 * keys are data and the whole map is the value being set.
 */
export function schemaAt(path: string): z.ZodType | null {
  let node: z.ZodType = ConfigSchema;
  for (const key of path.split(".")) {
    const shape = (node as unknown as { shape?: Record<string, z.ZodType> }).shape;
    if (!shape?.[key]) return null;
    node = shape[key];
  }
  return node;
}

/** Every settable dotted path, with the schema that judges it. */
export function paths(node: z.ZodType = ConfigSchema, prefix = ""): Map<string, z.ZodType> {
  const out = new Map<string, z.ZodType>();
  const shape = (node as unknown as { shape?: Record<string, z.ZodType> }).shape;
  if (!shape) return out;
  for (const [k, v] of Object.entries(shape)) {
    const p = prefix ? `${prefix}.${k}` : k;
    const inner = (v as unknown as { shape?: unknown }).shape;
    if (inner) for (const [q, w] of paths(v, p)) out.set(q, w);
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
  const t = (schema as unknown as { def: { type: string } }).def.type;
  if (t === "record") return "object";
  if (t === "union") return "object";
  return t;
}

/** The keys a block enumerates, or none if it is a leaf or an open map. */
export function keysUnder(prefix: string): string[] {
  const node = prefix ? schemaAt(prefix) : ConfigSchema;
  const shape = (node as unknown as { shape?: Record<string, unknown> } | null)?.shape;
  return shape ? Object.keys(shape) : [];
}
