import { defu } from "defu";
import { z } from "zod";
import { ConfigSchema } from "../../contracts/config.ts";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Roles are configuration, not code.
 *
 * Adding a Composer, a Translator or an Artist is a new yaml file and nothing
 * else — the only thing that differs between an Engineer and a Composer is the
 * prompt, the model tier and the tool whitelist. True because of `capabilities:`
 * below and `roleWith`: the flow asks what a role does, never its name.
 * `test/platform/role-capability.test.ts` is this paragraph as a test, and was
 * shown failing before it was kept.
 */

/**
 * Reasoning effort, one word for both CLIs.
 *
 * Both offer low/medium/high/xhigh/max; only `gpt-5.6-sol` adds `ultra`, so that
 * one word is the whole difference and the claude adapter clamps it to `max`
 * rather than carrying a mapping table.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** Which provider a role gets when its yaml does not say. */
export const DEFAULT_PROVIDER = "claude";

/**
 * What a role can be asked to do.
 *
 * The flow asks for a capability and never for a name: `handToQa` wants whoever
 * reviews a slice, and which role that is belongs in yaml. So a new role is still
 * one file — but a new *capability* is code, because something has to dispatch on
 * it, and an entry here nothing dispatches is a promise the system cannot keep.
 */
const CAPABILITIES = [
  "write_code",
  "review_slice",
  "audit_branch",
  "plan_requirement",
  "lead_group",
  "write_pr_message",
  "compress_context",
  "bootstrap_env",
  "cut_boundary",
  "triage_boss_feedback",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const RoleDefSchema = z.object({
  name: z.string().min(1),
  /**
   * Which tier this role always needs, regardless of slice difficulty. The
   * Dispatcher is `hard` because a badly split requirement costs more than the
   * strong model does. Omit to let the slice's difficulty tag decide.
   */
  tier: z.enum(["trivial", "normal", "hard"]).optional(),
  /** A concrete model id, pinned. Wins over `tier` and over difficulty. */
  model: z.string().optional(),
  /**
   * Tool rounds this role gets, overriding `maxTurnsPerJob`.
   *
   * Every round re-reads all tool results, so rounds are the token bill — but the
   * right number is not one number: a review reads a diff and files a verdict
   * while an engineer runs a test-fix loop, and one cap for both has to be the
   * engineer's.
   */
  maxTurns: z.number().int().positive().optional(),
  /** How hard the model thinks per turn. Part of the cached prefix, see assemble.ts. */
  effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  prompt: z.string().min(1),
  /** Which tools this role gets. The sandbox is the boundary; this is the budget. */
  allowedTools: z.array(z.string()).optional(),
  /** Which CLI runs this role's turns. A role is config, so this is too. */
  runtime: z.string().optional(),
  /** What this role can be asked to do. The flow dispatches on these, not on `name`. */
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
});
export type RoleDef = z.infer<typeof RoleDefSchema>;
export type Roles = Map<string, RoleDef>;

/**
 * Where skills can be staged such that a container actually sees them.
 *
 * `/var/tmp/orch-cache` matches opensandbox-server's own default allowlist and is
 * right on Linux. On macOS the runtime is a VM and `/var/tmp` there is the VM's
 * own, so the bind succeeds and delivers nothing — see `Config.skillsDir`. A path
 * under `$HOME` is shared into the VM and works.
 */
function defaultSkillsDir(): string {
  if (platform() === "darwin") return join(homedir(), ".orch-cache/skills");
  // Windows has no `/var/tmp`, and this is one side of a bind mount performed by a
  // docker daemon that lives in WSL and does not read drive letters the same way.
  // A path under the user's profile is at least one this process can create;
  // `ORCH_SKILLS_DIR` and a line in `allowed_host_paths` make the two ends agree.
  if (platform() === "win32") return join(homedir(), ".orch-cache", "skills");
  return "/var/tmp/orch-cache/skills";
}

/**
 * What a legal config is, as one declaration.
 *
 * `z.infer` off the schema, so there is only one: a field in a hand-written type
 * but not in the schema is a setting the panel cannot show and the boot check will
 * not police. A type alias, not an interface — an interface has no implicit index
 * signature, and the config checker's whole job is to walk this key by key.
 */
export type Config = z.infer<typeof ConfigSchema>;

const DEFAULTS: Config = {
  language: "中文",
  maxGroups: 10,
  // `{default: 2, browser: 1}`, not a flat 2: each browser lease is a real
  // Chromium, and one global number could only ever be the browser's, which
  // starves the typechecks.
  leaseSlots: { default: 2, browser: 1 },
  host: "127.0.0.1",
  port: 47821,
  difficultyModel: {
    claude: {
      trivial: "claude-haiku-4-5-20251001",
      normal: "claude-sonnet-5",
      hard: "claude-opus-5",
    },
    // GPT-5.6's three tiers line up with the three difficulties on their own.
    codex: {
      trivial: "gpt-5.6-luna",
      normal: "gpt-5.6-terra",
      hard: "gpt-5.6-sol",
    },
  },
  turnTimeoutMs: 1_200_000,
  maxTurnsPerJob: 45,
  sessionRotateFraction: 0.6,
  unreadDigestThreshold: 30,
  feedbackSedimentThreshold: 3,
  ctxBudgetChars: 16_000,
  // Today's literals, unchanged: this is about making them settable, not about
  // retuning them. Depth 3 answered every question the walk was measured on in
  // two calls; a fourth level is a third serial call on every query that reaches
  // it, which is what makes this the expensive number of the two.
  pageindex: { depth: 3, width: 4 },
  notifyWebhook: "",
  parkAfterPausedMs: 7_200_000,
  watchdogIntervalMs: 30_000,
  gateRetries: 2,
  leaseTimeoutMs: 10_800_000,
  installTimeoutMs: 10_800_000,
  // Today's literals, unchanged: this is about making them settable, not about
  // retuning them. Two are worth knowing about — `sandboxPingMs` and
  // `networkPingMs` differ by a second that nobody appears to have chosen, and
  // `usageReadMs` is the container round trip around a `curl -m 10` that is still
  // a literal in the command string.
  timeouts: {
    githubApiMs: 15_000,
    credentialCheckMs: 6_000,
    webhookMs: 5_000,
    sandboxPingMs: 3_000,
    networkPingMs: 2_000,
    tokenRefreshMs: 120_000,
    usageReadMs: 30_000,
    transferMs: 600_000,
  },
  intervals: {
    recheckMs: 5 * 60_000,
    usagePollMs: 10 * 60_000,
    usageBackoffMs: 45 * 60_000,
    notifyBatchMs: 30 * 60_000,
    // 5 min, then 15, then hourly. A repeat is a reminder, not a new problem.
    notifyBackoffMs: [5 * 60_000, 15 * 60_000, 60 * 60_000],
  },
  // Measured against api.github.com: the whole query costs 1 point at these
  // counts. Threads are the narrower window on purpose — a thread carries every
  // reply, and the ones worth waking a group are the recent ones.
  prPoll: { prs: 30, messages: 20, checks: 100, threads: 20, threadComments: 10 },
  // On by default: "approved" should buy a night of work. The slice still waits to
  // be accepted; only the next one stops waiting. The cost, stated: a wrong slice
  // is discovered later with the following slices built on top of it, and
  // rejecting one then pauses the whole group and says so (postSliceDecision).
  autoAdvance: true,
  // trivial and normal. Four gates still run on both — self-review, reconcile,
  // the deterministic gate, an independent QA — so this skips the fifth layer,
  // the boss's own look. hard still waits for you.
  autoAcceptTiers: ["trivial", "normal"],
  // Set above the worst slice that actually finished and below the runaway: the
  // cap is for the agent that has lost the plot, not the one having a hard day.
  sliceBudgetTokens: { trivial: 8_000_000, normal: 20_000_000, hard: 30_000_000 },
  indexModel: { runtime: "codex", model: "gpt-5.6-luna" },
  // Deep enough that a browser catching up after a tab wakes never drops, and
  // shallow enough that a dead socket cannot hold a turn's worth of tokens.
  streamBacklog: 256,
  // A week, against 成本's 24-hour window: enough that a question asked on Monday
  // about Friday still has its evidence, and bounded so an installation that has
  // run for a year is not replaying a year to every reconnecting tab.
  eventRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  // In order. `main` first because it is what GitHub creates today, `master`
  // because it is what everything created before 2020 still has.
  baseBranchFallbacks: ["main", "master"],
  // Under the heartbeat that writes the spans, so a report is never staler than
  // the data it reads was when it was computed.
  dbPoolSize: 24,
  telemetryCacheMs: 15_000,
  watchdog: {
    // Three turns writing nothing, or five turns on the same file. Both were
    // chosen against real stalls: two is a hard day, six is a night wasted.
    idleTurns: 3,
    sameFile: 5,
    reemitMs: 30 * 60 * 1_000,
    nudgeAfterMs: 4 * 60 * 60 * 1_000,
    nudgeReemitMs: 6 * 60 * 60 * 1_000,
    pausedNotifyMs: 15 * 60 * 1_000,
  },
  // Local, and the smaller of the two ADR 031 measured — they ranked the same and
  // the gap it cares about did not close with the larger one. Nothing reads this
  // yet; `bun run embedding:check` does.
  embedding: { mode: "local", model: "Xenova/multilingual-e5-small", endpoint: "", credential: "" },
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
 * the server was launched from. Three shapes: source resolves `../../..`, a bundle
 * resolves `..`, and a `bun build --compile` binary resolves **neither** — its
 * modules live in a read-only virtual filesystem, so the executable's dir is root.
 */
function resolveRoot(): string {
  const explicit = process.env.ORCH_ROOT?.trim();
  if (explicit) return resolve(explicit);
  const here = dirname(new URL(import.meta.url).pathname);
  // `/$bunfs` on posix, `B:\~BUN` on Windows — bun's own markers for "this
  // module came out of the binary, not off the disk".
  if (here.startsWith("/$bunfs") || /^[A-Z]:\\~BUN/i.test(here)) return dirname(process.execPath);
  if (here.endsWith("/src/platform/config")) return resolve(here, "../../..");
  return resolve(here, "..");
}

export const ROOT = resolveRoot();

/**
 * dataDir is absolute from here on.
 *
 * Everything under it is the *host's* — the sqlite file, gate and lease logs,
 * turn transcripts, attachments, the staged skills directory. A relative path
 * resolves against whatever cwd the process was started with, and the failure was
 * a file "not found" that existed. Same lesson as ROOT above.
 */
export const withAbsoluteDataDir = (c: Config): Config => ({ ...c, dataDir: resolve(ROOT, c.dataDir) });

/**
 * The sandbox server's API key comes from the environment, not the yaml.
 *
 * config/default.yaml is committed, and a key in a committed file is a key that
 * leaks; an empty one means the server has no auth, which is the usual local
 * setup. Two spellings, because this is the one value both processes must agree
 * on, and disagreeing presents as every container failing to open with a 401.
 */
const SANDBOX_API_KEY_ENV = "ORCH_SANDBOX_API_KEY";
const SANDBOX_API_KEY_ALT = "ORCH_SANDBOX_KEY";

/**
 * The handful of keys a container deployment has to set without editing a file.
 *
 * An explicit table rather than a generic `ORCH_*` -> config mapper: the generic
 * version silently accepts `ORCH_SANDBOX_IMAGE`, which is a boundary decision
 * `allowedImage` exists to make. The yaml stays the place where a setting is
 * explained; this is the place a deployment overrides one.
 */
function fromEnv(cfg: Config): Config {
  const out = { ...cfg };
  const host = process.env.ORCH_HOST?.trim();
  if (host) out.host = ConfigSchema.shape.host.parse(host);
  const port = Number(process.env.ORCH_PORT);
  if (Number.isInteger(port) && port > 0 && port < 65_536) out.port = port;
  const dir = process.env.ORCH_DATA_DIR?.trim();
  if (dir) out.dataDir = resolve(dir);
  const server = process.env.ORCH_SANDBOX_SERVER?.trim();
  if (server) out.sandbox = { ...out.sandbox, server };
  // Where the ticked skills are staged for the mount. An environment variable as
  // well as a yaml key, because the path the sandbox server must allow is a
  // property of *this* installation, wherever the tarball was unpacked.
  const skills = process.env.ORCH_SKILLS_DIR?.trim();
  if (skills) out.skillsDir = resolve(skills);
  return out;
}

/** The defaults, for the checker that reads types and legal keys off them. */
export const DEFAULTS_FOR_CHECK: Config = DEFAULTS;

export function loadConfig(path = join(ROOT, "config/default.yaml")): Config {
  const parsed = existsSync(path)
    ? z.record(z.string(), z.json()).parse(Bun.YAML.parse(readFileSync(path, "utf8")) ?? {})
    : {};
  // Key by key, not block by block: a spread means a `sandbox:` naming two of its
  // eight fields drops the other six to `undefined`, and the symptom is a container
  // that will not start rather than a config error. `defu` is exactly this and
  // nothing else — arrays and scalars replace, plain objects recurse.
  //
  // Cloned, because `defu` fills an absent key **by reference**: a block that came
  // entirely from the defaults *was* the defaults' block, and one write through it
  // edited `DEFAULTS` for the rest of the process.
  const merged = ConfigSchema.parse(defu(parsed, structuredClone(DEFAULTS)));
  const cfg = ConfigSchema.parse(fromEnv(withAbsoluteDataDir(merged)));
  const key = process.env[SANDBOX_API_KEY_ENV] || process.env[SANDBOX_API_KEY_ALT];
  return key ? { ...cfg, sandbox: { ...cfg.sandbox, apiKey: key } } : cfg;
}

/**
 * Which role has this capability.
 *
 * Throws on none and on two. An unresolved role reaches a job payload as
 * `undefined` and becomes a turn that never dispatches — a group that has simply
 * stopped, with nothing on the boss's screen saying why. Two is worse: the answer
 * would depend on `readdir` order, so it would be right until a file is renamed.
 */
export function roleWith(roles: Roles, cap: Capability): string {
  const found = [...roles.values()].filter((r) => r.capabilities?.includes(cap));
  if (found.length === 1) return found[0]!.name;
  if (found.length === 0) throw new Error(`no role in roles/ declares the capability "${cap}"`);
  // Sorted, so the message does not depend on the `readdir` order this branch
  // exists to stop letting decide anything.
  const who = found
    .map((r) => r.name)
    .sort()
    .join(", ");
  throw new Error(`capability "${cap}" is declared by ${who}; exactly one role may`);
}

/** Boot check: every capability the flow dispatches on resolves to exactly one role. */
export function checkCapabilities(roles: Roles): void {
  for (const cap of CAPABILITIES) roleWith(roles, cap);
}

export function loadRoles(dir = join(ROOT, "roles")): Map<string, RoleDef> {
  const out = new Map<string, RoleDef>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const r = RoleDefSchema.parse(Bun.YAML.parse(readFileSync(join(dir, f), "utf8")), {
      error: () => `${f}: invalid role`,
    });
    out.set(r.name, r);
  }
  return out;
}

/**
 * Which model runs this turn.
 *
 * A role may pin one, otherwise the slice's difficulty tag decides — that tag is
 * the boss's cost knob, editable right on the DRAFT card. The provider picks the
 * table first: a claude model id handed to `codex exec -m` is rejected outright.
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
