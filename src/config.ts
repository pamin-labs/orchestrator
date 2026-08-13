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
  leaseSlots: number;
  port: number;
  difficultyModel: Record<string, string>;
  turnTimeoutMs: number;
  maxTurnsPerJob: number;
  sessionRotateFraction: number;
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
  maxGroups: 3,
  leaseSlots: 1,
  port: 47821,
  difficultyModel: {
    trivial: "claude-haiku-4-5-20251001",
    normal: "claude-sonnet-5",
    hard: "claude-opus-5",
  },
  turnTimeoutMs: 600_000,
  maxTurnsPerJob: 60,
  sessionRotateFraction: 0.6,
  ctxBudgetChars: 16_000,
  parkAfterPausedMs: 7_200_000,
  watchdogIntervalMs: 30_000,
  gateRetries: 2,
  leaseTimeoutMs: 10_800_000,
  // Off by default: the point of slice-sized delivery is that a wrong slice wastes
  // one slice. Turning this on trades that for overnight throughput.
  autoAdvance: false,
  // Empty by default. Adding "trivial" trades the slice-sized blast radius for an
  // unattended overnight run: three gates still run, the boss's look does not.
  autoAcceptTiers: [],
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

export function loadConfig(path = join(ROOT, "config/default.yaml")): Config {
  if (!existsSync(path)) return { ...DEFAULTS };
  const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as Partial<Config> | null;
  return { ...DEFAULTS, ...(parsed ?? {}) };
}

export function loadRoles(dir = join(ROOT, "roles")): Map<string, RoleDef> {
  const out = new Map<string, RoleDef>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const r = Bun.YAML.parse(readFileSync(join(dir, f), "utf8")) as RoleDef;
    if (!r?.name || !r?.prompt) throw new Error(`${f}: a role needs at least name and prompt`);
    out.set(r.name, { clearance: "L1", ...r });
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
