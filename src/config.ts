import { defu } from "defu";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
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

/**
 * A type alias rather than an interface, on purpose: an interface has no
 * implicit index signature, so nothing typed can read it key by key without a
 * cast — and the config checker's whole job is to walk it key by key.
 */
/**
 * Where skills can be staged such that a container actually sees them.
 *
 * `/var/tmp/orch-cache` matches opensandbox-server's own default allowlist and is
 * right on Linux. On macOS the runtime is a VM and `/var/tmp` there is the VM's
 * own, so the bind succeeds and delivers nothing — see `Config.skillsDir`. A path
 * under `$HOME` is shared into the VM and works.
 */
export function defaultSkillsDir(): string {
  return platform() === "darwin"
    ? join(homedir(), ".orch-cache/skills")
    : "/var/tmp/orch-cache/skills";
}

export type Config = {
  language: string;
  maxGroups: number;
  /** One number for the whole Runner pool, or one pool per resource tag. */
  leaseSlots: number | Record<string, number>;
  /** Which interface to listen on. `127.0.0.1` unless something fronts it. */
  host: string;

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
  dataDir: string;
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
  skillsDir: string;
};

const DEFAULTS: Config = {
  language: "中文",
  maxGroups: 10,
  leaseSlots: 2,
  host: "127.0.0.1",
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
    image: "ghcr.io/pamin-labs/orch-agent:latest",
    cpu: "",
    memory: "8Gi",
    ttlSeconds: 86400,
    denyDomains: [],
    cacheDirs: {},
  },
  dataDir: "data",
  skillsDir: defaultSkillsDir(),
};

/**
 * Repo root, derived from this file rather than from cwd.
 *
 * `roles/` and `config/` are part of the installation, not of whatever directory
 * the server happened to be launched from — resolving them against cwd meant a
 * server started elsewhere silently found no roles at all.
 *
 * Three shapes this has to answer for, and the third is why it is a function:
 *
 *   source        `<root>/src/config.ts`   ->  `..`
 *   bundled       `<root>/dist/server.js`  ->  `..`
 *   compiled      `/$bunfs/root/config.ts` ->  nothing. `bun build --compile`
 *                 puts modules in a read-only virtual filesystem, so `..` is
 *                 `/$bunfs`, and `config/default.yaml`, `roles/*.yaml`,
 *                 `web/dist` and the `orch` CLI copied into every sandbox all
 *                 resolve to paths that do not exist. Measured: the binary
 *                 starts, warns that the config is missing, and then dies trying
 *                 to `mkdir` a data directory on a read-only mount.
 *
 * For the compiled case the executable's own directory is the real one, which
 * makes a single-file binary usable as long as its assets sit beside it.
 * `ORCH_ROOT` overrides all three, for a layout that is none of them.
 */
function resolveRoot(): string {
  const explicit = process.env.ORCH_ROOT?.trim();
  if (explicit) return resolve(explicit);
  const here = dirname(new URL(import.meta.url).pathname);
  // `/$bunfs` on posix, `B:\~BUN` on Windows — bun's own markers for "this
  // module came out of the binary, not off the disk".
  if (here.startsWith("/$bunfs") || /^[A-Z]:\\~BUN/i.test(here)) return dirname(process.execPath);
  return resolve(here, "..");
}

export const ROOT = resolveRoot();

/**
 * dataDir is absolute from here on.
 *
 * Everything under it is the *host's* — the sqlite file, gate and lease logs,
 * turn transcripts, attachments, the staged skills directory. A relative path
 * resolved against whatever cwd the process happened to be started with, and the
 * failure was a file "not found" that existed. Same lesson as ROOT above.
 *
 * The reason used to be stated as "handed to subprocesses that do not run where
 * the server does". Since 005 no subprocess sees `dataDir` at all — turns run in
 * containers and reach the host only through the mailbox — so that sentence
 * would have had the next reader looking for a boundary that is not here. The
 * conclusion is unchanged; the reason is that this process can be started from
 * anywhere.
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

/**
 * The handful of keys a container deployment has to set without editing a file.
 *
 * An explicit table rather than a generic `ORCH_*` -> config mapper: the generic
 * version reads well and then silently accepts `ORCH_SANDBOX_IMAGE`, which is a
 * boundary decision `allowedImage` exists to make. These four are the ones an
 * image cannot know at build time, and nothing else is settable this way.
 *
 * The yaml stays the place where a setting is explained; this is the place a
 * deployment overrides one.
 */
function fromEnv(cfg: Config): Config {
  const out = { ...cfg };
  const host = process.env.ORCH_HOST?.trim();
  if (host) out.host = host;
  const port = Number(process.env.ORCH_PORT);
  if (Number.isInteger(port) && port > 0 && port < 65_536) out.port = port;
  const dir = process.env.ORCH_DATA_DIR?.trim();
  if (dir) out.dataDir = resolve(dir);
  const server = process.env.ORCH_SANDBOX_SERVER?.trim();
  if (server) out.sandbox = { ...out.sandbox, server };
  return out;
}

/** The defaults, for the checker that reads types and legal keys off them. */
export const DEFAULTS_FOR_CHECK: Config = DEFAULTS;


export function loadConfig(path = join(ROOT, "config/default.yaml")): Config {
  const parsed = existsSync(path)
    ? ((Bun.YAML.parse(readFileSync(path, "utf8")) as Partial<Config> | null) ?? {})
    : {};
  // Key by key, not block by block: a spread means a `sandbox:` naming two of
  // its eight fields drops the other six to `undefined`, and the symptom is a
  // container that will not start rather than a config error. `defu` is exactly
  // this and nothing else — arrays and scalars replace, plain objects recurse —
  // and JS has no stdlib deep merge worth hand-rolling around.
  const cfg = fromEnv(withAbsoluteDataDir(defu(parsed, DEFAULTS)));
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
