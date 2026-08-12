import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
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
  gateRetries: number;
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
  maxTurnsPerJob: 30,
  sessionRotateFraction: 0.6,
  ctxBudgetChars: 16_000,
  parkAfterPausedMs: 7_200_000,
  gateRetries: 2,
  workRoot: "/tmp/orch/worktrees",
  dataDir: "data",
};

export function loadConfig(path = "config/default.yaml"): Config {
  if (!existsSync(path)) return { ...DEFAULTS };
  const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as Partial<Config> | null;
  return { ...DEFAULTS, ...(parsed ?? {}) };
}

export function loadRoles(dir = "roles"): Map<string, RoleDef> {
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
