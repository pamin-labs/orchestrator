import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Roles are configuration, not code.
 *
 * Adding a Composer, a Translator or an Artist is a new yaml file and nothing
 * else — the only thing that differs between an Engineer and a Composer is the
 * prompt, the model tier and the tool whitelist.
 */

/**
 * Reasoning effort, one word for both CLIs.
 *
 * Measured off the two installations rather than assumed: `claude --help` offers
 * `--effort (low, medium, high, xhigh, max)`, and every entry in codex's
 * `models_cache.json` lists the same five under `supported_reasoning_levels`.
 * Only `gpt-5.6-sol` adds `ultra`, so that one word is the whole difference and
 * the claude adapter clamps it to `max` rather than carrying a mapping table.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/**
 * A key into the provider registry (src/runtime/providers.ts), not a closed set.
 * Deliberately a string: adding a provider must not mean widening a union that
 * half the codebase switches on.
 */
export type Runtime = string;

/** Which provider a role gets when its yaml does not say. */
export const DEFAULT_PROVIDER = "claude";

export interface RoleDef {
  name: string;
  /**
   * Which tier this role always needs, regardless of slice difficulty. The
   * Dispatcher is `hard` because a badly split requirement costs more than the
   * strong model does. Omit to let the slice's difficulty tag decide.
   */
  tier?: "trivial" | "normal" | "hard";
  /** A concrete model id, pinned. Wins over `tier` and over difficulty. */
  model?: string;
  /**
   * Tool rounds this role gets, overriding `maxTurnsPerJob`.
   *
   * Measured: tool results are 90% of everything in a transcript, and every round
   * re-reads all of them, so rounds are the token bill. But the right number is
   * not one number — a review reads a diff and files a verdict, while an engineer
   * runs a test-fix loop. One cap for both has to be the engineer's, and the
   * reviewers spend it.
   */
  maxTurns?: number;
  /** How hard the model thinks per turn. Part of the cached prefix, see assemble.ts. */
  effort?: Effort;
  prompt: string;
  /** Which tools this role gets. The sandbox is the boundary; this is the budget. */
  allowedTools?: string[];
  /** Which CLI runs this role's turns. A role is config, so this is too. */
  runtime?: Runtime;
}

export interface Config {
  language: string;
  maxGroups: number;
  /** One number for the whole Runner pool, or one pool per resource tag. */
  leaseSlots: number | Record<string, number>;
  port: number;
  /** provider -> difficulty -> model. One knob per family; adding one is a yaml block. */
  difficultyModel: Record<Runtime, Record<string, string>>;
  turnTimeoutMs: number;
  maxTurnsPerJob: number;
  sessionRotateFraction: number;
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
  installTimeoutMs: number;
  /** Start the next slice when QA passes, without waiting for the boss to accept. */
  autoAdvance: boolean;
  /** Difficulty tags accepted automatically once all three gates pass. */
  autoAcceptTiers: string[];
  /**
   * Token cap written onto every new slice. difficulty -> cap.
   *
   * Until this existed `budget_tokens` was never INSERTed, so it was NULL on every
   * row and the two admission checks in scheduler.ts had never stopped anything.
   * It matters more now: QA moved to a CLI with no tool whitelist, and a budget is
   * the deterministic replacement for the whitelist that used to bound its reading.
   */
  sliceBudgetTokens: Record<string, number>;
  /**
   * Who answers `orch ctx query` and writes the index summaries.
   *
   * The most frequent model call in the system and pure summarisation — no
   * decision, no tools, no blackboard — so it is the first thing that should come
   * off the expensive subscription.
   */
  indexModel: { runtime: Runtime; model: string };
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
  contextWindow: Record<string, number>;
  /**
   * One sandbox per group — the write boundary (docs/decisions/005).
   *
   * `cpu` empty means a quarter of the host's cores; the SDK's own default of
   * "1" made this repo's typecheck 3.7x slower than the host. Per-project
   * overrides live in `project.config_json.sandbox`.
   */
  sandbox: {
    server: string;
    apiKey: string;
    image: string;
    cpu: string;
    memory: string;
    ttlSeconds: number;
    denyDomains: string[];
    /** mount path -> host path, shared by every sandbox. Package caches only. */
    cacheDirs: Record<string, string>;
  };
  workRoot: string;
  dataDir: string;
}

const DEFAULTS: Config = {
  language: "中文",
  maxGroups: 10,
  leaseSlots: 2,
  port: 47821,
  difficultyModel: {
    claude: {
      trivial: "claude-haiku-4-5-20251001",
      normal: "claude-sonnet-5",
      hard: "claude-opus-5",
    },
    // GPT-5.6's three tiers line up with the three difficulties on their own:
    // models_cache.json records `gpt-5.4 -> terra` and `gpt-5.4-mini -> luna` as its
    // own upgrade path, and sol is the flagship.
    codex: {
      trivial: "gpt-5.6-luna",
      normal: "gpt-5.6-terra",
      hard: "gpt-5.6-sol",
    },
  },
  turnTimeoutMs: 600_000,
  maxTurnsPerJob: 45,
  sessionRotateFraction: 0.6,
  unreadDigestThreshold: 30,
  feedbackSedimentThreshold: 3,
  ctxBudgetChars: 16_000,
  parkAfterPausedMs: 7_200_000,
  watchdogIntervalMs: 30_000,
  gateRetries: 2,
  leaseTimeoutMs: 10_800_000,
  installTimeoutMs: 10_800_000,
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
  // Measured over the 16 slices in this checkout that spent anything: trivial
  // averaged 4.0M with one 12.0M runaway, normal averaged 7.3M with a 16.1M tail,
  // the single hard slice took 4.0M. So these are set above the worst slice that
  // actually finished and below the runaway — the cap is for the agent that has
  // lost the plot, not for the one having a hard day.
  sliceBudgetTokens: { trivial: 8_000_000, normal: 20_000_000, hard: 30_000_000 },
  indexModel: { runtime: "codex", model: "gpt-5.6-luna" },
  contextWindow: {
    default: 200_000,
    "claude-haiku-4-5-20251001": 200_000,
    "claude-sonnet-5": 1_000_000,
    "claude-opus-5": 1_000_000,
    "gpt-5.6-sol": 272_000,
    "gpt-5.6-terra": 272_000,
    "gpt-5.6-luna": 272_000,
  },
  sandbox: {
    server: "127.0.0.1:8080",
    apiKey: "",
    image: "orch/agent:1",
    cpu: "",
    memory: "8Gi",
    ttlSeconds: 86400,
    denyDomains: [],
    cacheDirs: {},
  },
  workRoot: "/var/tmp/orch/worktrees",
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

/**
 * The sandbox server's API key comes from the environment, not the yaml.
 *
 * config/default.yaml is committed, and a key in a committed file is a key that
 * leaks. An empty one means the server has no auth, which is the usual local
 * setup and is fine — preflight reports what it finds either way.
 */
const SANDBOX_API_KEY_ENV = "ORCH_SANDBOX_API_KEY";

export function loadConfig(path = join(ROOT, "config/default.yaml")): Config {
  const parsed = existsSync(path)
    ? ((Bun.YAML.parse(readFileSync(path, "utf8")) as Partial<Config> | null) ?? {})
    : {};
  const cfg = withAbsoluteDataDir({ ...DEFAULTS, ...parsed });
  const key = process.env[SANDBOX_API_KEY_ENV];
  return key ? { ...cfg, sandbox: { ...cfg.sandbox, apiKey: key } } : cfg;
}

export function loadRoles(dir = join(ROOT, "roles")): Map<string, RoleDef> {
  const out = new Map<string, RoleDef>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const r = Bun.YAML.parse(readFileSync(join(dir, f), "utf8")) as RoleDef;
    if (!r?.name || !r?.prompt) throw new Error(`${f}: a role needs at least name and prompt`);
    out.set(r.name, r);
  }
  return out;
}

/**
 * Which model runs this turn.
 *
 * A role may pin one (the Auditor wants a specific reviewer), otherwise the
 * slice's difficulty tag decides — that tag is the boss's cost knob, editable
 * right on the DRAFT card. The provider picks the table first: a claude model id
 * handed to `codex exec -m` is rejected outright, and before this split that is
 * exactly what a `runtime: codex` role would have got.
 */
export function modelFor(cfg: Config, role: RoleDef, difficulty?: string | null): string {
  if (role.model) return role.model;
  const table = cfg.difficultyModel[role.runtime ?? DEFAULT_PROVIDER] ?? {};
  const tier = role.tier ?? difficulty ?? "normal";
  return table[tier] ?? table.normal ?? "";
}

/**
 * How much context this model has, clamped to something a rotation can use.
 *
 * `reported` is what the CLI said during the turn and is believed first — a table
 * goes stale the week a model ships. The clamp is the safety net around both: an
 * absurd value (a shape change, a zero, a provider inventing a number) must not
 * turn into a session that never rotates or one that rotates every turn.
 */
export const MIN_CONTEXT = 100_000;
export const MAX_CONTEXT = 2_000_000;

export function contextWindowFor(cfg: Config, model: string, reported?: number | null): number {
  const raw = reported || cfg.contextWindow?.[model] || cfg.contextWindow?.default || MIN_CONTEXT;
  return Math.min(MAX_CONTEXT, Math.max(MIN_CONTEXT, raw));
}

/** Token cap for a new slice at this difficulty. */
export function sliceBudgetFor(cfg: Config, difficulty?: string | null): number {
  const t = cfg.sliceBudgetTokens;
  return t[difficulty ?? "normal"] ?? t.normal!;
}
