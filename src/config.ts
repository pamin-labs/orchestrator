import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Clearance } from "./mech/clearance.ts";

/**
 * Roles are configuration, not code.
 *
 * Adding a Composer, a Translator or an Artist is a new yaml file and nothing
 * else — the only thing that differs between an Engineer and a Composer is the
 * prompt, the model tier and the tool whitelist.
 */

export interface RoleDef {
  name: string;
  clearance: Clearance;
  /**
   * Which tier this role always needs, regardless of slice difficulty. The
   * Dispatcher is `hard` because a badly split requirement costs more than the
   * strong model does. Omit to let the slice's difficulty tag decide.
   */
  tier?: "trivial" | "normal" | "hard";
  /** A concrete model id, pinned. Wins over `tier` and over difficulty. */
  model?: string;
  thinking?: "off" | "low" | "medium" | "high";
  prompt: string;
  /** Overrides the default whitelist from clearance.ts when present. */
  allowedTools?: string[];
  /** Which CLI runs this role's turns. A role is config, so this is too. */
  runtime?: "claude" | "codex";
}

export interface Config {
  language: string;
  maxGroups: number;
  /** One number for the whole Runner pool, or one pool per resource tag. */
  leaseSlots: number | Record<string, number>;
  port: number;
  difficultyModel: Record<string, string>;
  turnTimeoutMs: number;
  maxTurnsPerJob: number;
  sessionRotateFraction: number;
  /** model -> the cheaper model to fall back to when the account is throttled. */
  modelFallback: Record<string, string>;
  /** Unread events past this get compressed by the Librarian instead of dribbling. */
  unreadDigestThreshold: number;
  /** The same complaint this many times becomes a project rule. */
  feedbackSedimentThreshold: number;
  ctxBudgetChars: number;
  parkAfterPausedMs: number;
  watchdogIntervalMs: number;
  gateRetries: number;
  /** Wall clock for one leased command. A big compile is hours, not minutes. */
  leaseTimeoutMs: number;
  /** Start the next slice when QA passes, without waiting for the boss to accept. */
  autoAdvance: boolean;
  /** Difficulty tags accepted automatically once all three gates pass. */
  autoAcceptTiers: string[];
  workRoot: string;
  dataDir: string;
}

const DEFAULTS: Config = {
  language: "中文",
  maxGroups: 10,
  leaseSlots: 2,
  port: 47821,
  difficultyModel: {
    trivial: "claude-haiku-4-5-20251001",
    normal: "claude-sonnet-5",
    hard: "claude-opus-5",
  },
  turnTimeoutMs: 600_000,
  maxTurnsPerJob: 45,
  sessionRotateFraction: 0.6,
  // Where a rate-limited turn goes next. One step down, not straight to haiku: the
  // point is to keep going at a lower tier, not to make the cheapest possible mess.
  modelFallback: {
    "claude-opus-5": "claude-sonnet-5",
    "claude-sonnet-5": "claude-haiku-4-5-20251001",
  },
  unreadDigestThreshold: 30,
  feedbackSedimentThreshold: 3,
  ctxBudgetChars: 16_000,
  parkAfterPausedMs: 7_200_000,
  watchdogIntervalMs: 30_000,
  gateRetries: 2,
  leaseTimeoutMs: 10_800_000,
  // On by default: "approved" should buy a night of work. Accepting a slice was what
  // started the next one, so with this off a group did exactly one slice and then
  // waited until morning — which defeats the reason the system exists. The slice still
  // waits to be accepted; only the next one stops waiting.
  //
  // The cost, stated: a wrong slice is discovered later, with the following slices
  // built on top of it. Rejecting one then pauses the whole group and says so
  // (postSliceDecision), rather than quietly fixing the foundation under finished work.
  autoAdvance: true,
  // trivial only. Three gates still run on it — self-review, the deterministic gate,
  // an independent QA — so this skips the fourth layer, the boss's look, on the tier
  // where that look is worth least. normal and hard still wait for you.
  autoAcceptTiers: ["trivial"],
  workRoot: "/tmp/orch/worktrees",
  dataDir: "data",
};

/**
 * Repo root, derived from this file rather than from cwd.
 *
 * `roles/` and `config/` are part of the installation, not of whatever directory
 * the server happened to be launched from — resolving them against cwd meant a
 * server started elsewhere silently found no roles at all.
 */
export const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

/**
 * dataDir is absolute from here on.
 *
 * Everything under it is handed to a subprocess — the clearance profile as
 * `--settings`, the `orch` shim as a PATH entry — and those subprocesses run in
 * the group's worktree. A relative `data/profiles/19-L2.json` resolved against
 * the worktree, where nothing of the sort exists, and every turn in a worktree
 * died with "Settings file not found" while planning roles (cwd = repo root)
 * kept working. Same lesson as ROOT above, one directory over.
 */
export const withAbsoluteDataDir = (c: Config): Config => ({ ...c, dataDir: resolve(ROOT, c.dataDir) });

export function loadConfig(path = join(ROOT, "config/default.yaml")): Config {
  if (!existsSync(path)) return withAbsoluteDataDir({ ...DEFAULTS });
  const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as Partial<Config> | null;
  return withAbsoluteDataDir({ ...DEFAULTS, ...(parsed ?? {}) });
}

export function loadRoles(dir = join(ROOT, "roles")): Map<string, RoleDef> {
  const out = new Map<string, RoleDef>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const r = Bun.YAML.parse(readFileSync(join(dir, f), "utf8")) as RoleDef;
    if (!r?.name || !r?.prompt) throw new Error(`${f}: a role needs at least name and prompt`);
    out.set(r.name, { ...r, clearance: r.clearance ?? "L1" });
  }
  return out;
}

/**
 * Which model runs this turn.
 *
 * A role may pin one (the Dispatcher always needs the strong model), otherwise
 * the slice's difficulty tag decides — that tag is the boss's cost knob, editable
 * right on the DRAFT card.
 */
export function modelFor(cfg: Config, role: RoleDef, difficulty?: string | null): string {
  if (role.model) return role.model;
  const tier = role.tier ?? difficulty ?? "normal";
  return cfg.difficultyModel[tier] ?? cfg.difficultyModel.normal!;
}
