import { z } from "zod";

/**
 * What a legal config is, in one place.
 *
 * There were two answers and they disagreed. `checkconfig.ts` walked `DEFAULTS` at
 * boot with its own `kind()`, a `POSITIVE` set and a `UNIONS` table; `settings.ts`
 * walked the same defaults for the panel and checked `typeof` only.
 */
/**
 * The panel was the weaker one and the gap was not cosmetic: `{path: "maxGroups",
 * value: 0}` was accepted, and the scheduler's admission test is
 * `busyGroups.size >= maxGroups()` — so zero means no group turn is ever dispatched
 * again, silently, and the override is persisted so a restart does not clear it.
 *
 * One schema, consumed by both. A bound that exists here cannot be missing from one
 * of the two doors.
 */

/** A positive whole number of milliseconds, tokens, slots, rounds. */
const count = z.number().int().positive();

/** `2` is one pool that size; a map is one pool per resource tag. */
const LeaseSlots = z.union([count, z.record(z.string(), count)]);

const ModelRef = z.object({ runtime: z.string().min(1), model: z.string() });

/**
 * Where an embedding would come from, if one is ever used.
 *
 * ADR 031 refused embeddings on a measurement, not on principle, and half its
 * reopen check *cannot be run* without this: whether a hosted embedding does
 * better is "not measured and deliberately not guessed", because the test needs
 * the endpoint the boss would choose. So this is the knob that makes the refusal
 * falsifiable; `bun run embedding:check` is the other half.
 */
/**
 * **`local` is the default and remote is a decision.** A hosted embedding sends
 * every passage it ranks, and the corpus is the boss's own requirements and
 * acceptance criteria. `docs/standards/security.md` carries the boundary.
 */
export const EmbeddingRef = z
  .object({
    mode: z.enum(["local", "remote"]),
    /**
     * Local: a model id `@huggingface/transformers` resolves — ADR 031 measured
     * `Xenova/multilingual-e5-small` and `-base`, and names `BAAI/bge-m3` as the
     * candidate built for the case that failed. Remote: whatever the endpoint
     * calls its model.
     */
    model: z.string().min(1),
    /**
     * An OpenAI-shaped `/v1/embeddings` URL, written out in full rather than
     * assembled from a host — "which path does this provider use" is the
     * question a base URL makes somebody guess at.
     */
    endpoint: z.string(),
    /**
     * The name of a `runtime_auth` row, never a key. A secret in the config file
     * is a secret in the boss's shell history and in every backup of it.
     */
    credential: z.string(),
  })
  // Flat with a mode rather than a discriminated union: the union doubles this
  // object in every inferred RPC type, and `web/src/shared/api.ts` is already at
  // the compiler's serialization ceiling — it failed with TS7056 on the first cut.
  // Empty strings rather than optionals, because `knobs/view.tsx` walks this
  // schema generically and `undefined` is not one of the values it can render.
  .refine((v) => v.mode === "local" || (URL.canParse(v.endpoint) && !!v.credential), {
    error: "a remote embedding needs an endpoint URL and the name of a stored credential",
  });
export type EmbeddingRef = z.infer<typeof EmbeddingRef>;

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
  /**
   * Loopback only, and the refusal says why.
   *
   * Boss routes have no login: whoever reaches the port is the boss. A bare enum
   * error names three strings and leaves the reader to guess it is a policy —
   * `config/default.yaml` told container users to set `0.0.0.0` for two releases
   * while this refused it, and what they got was a startup failure with no reason
   * in it. Publish a port with `-p 127.0.0.1:47821:47821` instead.
   */
  host: z.enum(["127.0.0.1", "localhost", "::1"], {
    error: "host must be a loopback address: this server has no login, so anything reachable is the boss",
  }),
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
   * How far and how wide a model may walk the PageIndex tree.
   *
   * `depth` is serial model calls per `orch ctx query` — two per question at depth
   * 3, each with a 60s timeout — so it is the single knob on the most frequent
   * model spend here; `width` caps the ids the model may name at a level.
   * `enabled` is the A/B switch, on by default: off skips the walk before the tree
   * is loaded, so the query costs no model call and falls through to the lexical
   * half. Its own knob rather than `depth: 0`, which still walks, degenerately.
   */
  pageindex: z.object({ enabled: z.boolean(), depth: count, width: count }).strict(),
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
   * The same class of thing as a lease, so the same order of magnitude. It was 15
   * minutes, fine for this repo and wrong for the projects that need the headroom:
   * a monorepo's pnpm install, pip building numpy from source. Too short fails as
   * "this project is broken" rather than "that took longer than allowed".
   *
   * So the default is generous and the install streams.
   */
  installTimeoutMs: count,
  /**
   * How long one wait on something outside this process may take.
   *
   * Grouped by what is on the other end rather than by call site: these replaced
   * thirteen literals in seven files, and a config with thirteen timeout keys is
   * worse than the literals were, because nobody can hold it in their head. Sites
   * waiting on the same kind of thing share a key; where two kept different
   * numbers, the reason for the difference is on the key.
   */
  timeouts: z
    .object({
      /** One GitHub REST call, where the answer is the work somebody asked for. */
      githubApiMs: count,
      /**
       * "Do you still accept this credential": GitHub's `/user`, a provider's
       * `/v1/models`. Shorter than `githubApiMs` because both report "not
       * verified" rather than failing, and nothing is blocked on the answer.
       */
      credentialCheckMs: count,
      /** The boss's notification webhook: posted, and the answer discarded. */
      webhookMs: count,
      /**
       * Is the sandbox server up, and does it take our key.
       *
       * Separate from `networkPingMs` because it is usually loopback, and because
       * its answer only fills in a report while that one gates the whole fleet.
       * That said, 3s against 2s is not a number anybody chose.
       */
      sandboxPingMs: count,
      /**
       * Is there a network at all: HEAD to every provider origin, on the watchdog
       * tick. Short on purpose — it runs inside the tick, and a slow answer must
       * not hold one open.
       */
      networkPingMs: count,
      /**
       * The codex refresh-token exchange, run inside the utility container.
       *
       * Longer than `usageReadMs` because it is a process start plus an OAuth
       * round trip, where that one wraps a curl already carrying its own `-m`.
       */
      tokenRefreshMs: count,
      /** The subscription-usage read, curl'd from the utility container. */
      usageReadMs: count,
      /**
       * One operation that moves a repository or an image across the network.
       *
       * A clone, a fetch, a submodule init, and the sandbox SDK's own per-request
       * budget — whose worst case is an image pull, which is the same shape of
       * wait as a clone and was already the same number. Minutes, not seconds.
       */
      transferMs: count,
    })
    .strict(),
  /**
   * How long an answer about the world outside stays good before we ask again.
   *
   * The other half of `timeouts`: that one bounds a single wait, this one bounds
   * how often one is started. Each of these was a literal beside the loop that
   * read it, so the cadence of every background poll in the product was a source
   * edit away from being changed and nothing else.
   */
  intervals: z
    .object({
      /**
       * "We asked recently." The reachability probe's cadence while online, and
       * how long a credential verdict stays cached for the settings page — one
       * sentence, and both were already five minutes.
       */
      recheckMs: count,
      /**
       * How often the subscription-usage endpoint is read.
       *
       * It is undocumented and answers a faster poller with 429 for hours, and
       * the boss's own `/status` spends from the same budget. Ten minutes inside
       * a five-hour window is a 3% error at worst.
       */
      usagePollMs: count,
      /** ...and how long it is left alone once it has answered 429. */
      usageBackoffMs: count,
      /** How long a batched notification waits for company before it is sent. */
      notifyBatchMs: count,
      /**
       * The reminder ladder for one unanswered notification: the first repeat
       * waits the first step, and it holds at the last one forever. At least one
       * step, because an empty ladder means "repeat every tick".
       */
      notifyBackoffMs: z.array(count).min(1),
    })
    .strict(),
  /**
   * How many nodes one PR poll asks GitHub for.
   *
   * Node counts are what a GraphQL query costs and what a busy pull request
   * overflows: a hundred line-level threads read through a window of twenty means
   * the eighty oldest are never seen. That ceiling is a property of the repository
   * being watched, not of the watcher, so it is a setting rather than a constant.
   */
  prPoll: z.object({
    prs: count,
    messages: count,
    checks: count,
    threads: count,
    threadComments: count,
  }),
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
   * How long one 系统耗时 report is reused before it is computed again.
   *
   * The report is five window-function queries over the whole span table, run
   * synchronously — so while it computes, every other request and the SSE
   * heartbeat wait behind it. The data is written by a heartbeat and is never
   * fresher than that, so serving the same answer twice inside one tick costs
   * nothing and stops a reloading tab from blocking the fleet.
   */
  telemetryCacheMs: count,
  /**
   * Connections the server keeps open to Postgres.
   *
   * Bun's own default is 10 and nobody chose it. The panel's snapshot issues
   * nineteen statements at once, so a pool under that serves them in waves —
   * measured as a p95 several times the median while the median barely moves.
   * Above the statement count it buys nothing; a managed Postgres with a
   * connection cap is the reason to lower it.
   */
  dbPoolSize: count,
  /**
   * What the watchdog calls stuck, and how often it is willing to repeat itself.
   *
   * The interval was settable and every threshold it enforces was not, so the one
   * knob the panel offered changed how often the rules ran and nothing about what
   * they decided. `idleTurns`/`sameFile` are repetition; the `*Ms` are how long a
   * feed stays worth reading. `repoMapEveryMs` is how often the shared map is even
   * *checked* — a container round trip costing 947ms of every 30s tick, over 2,766
   * ticks, to answer "unchanged" about a map whose input is a push.
   */
  watchdog: z
    .object({
      idleTurns: count,
      sameFile: count,
      reemitMs: count,
      nudgeAfterMs: count,
      nudgeReemitMs: count,
      pausedNotifyMs: count,
      repoMapEveryMs: count,
    })
    .strict(),
  /**
   * The branch names to try when nothing else has answered.
   *
   * A project's own `base_branch` wins, then GitHub's `default_branch`; this is
   * the last resort, for a repository whose remote cannot be reached. It was
   * `["main", "master"]` in `gitops.ts` and `?? "main"` in three more places, so
   * a fleet whose repositories all develop on `develop` had four literals to
   * argue with and no way to say so once.
   */
  baseBranchFallbacks: z.array(z.string().min(1)).min(1),
  /**
   * How long a machine-generated event is kept.
   *
   * The conversation — `say`, `boss_say`, `note`, `escalation` — is never dropped:
   * it is the record, and the unread cursor walks it. This bounds the rest, which
   * is read inside a day (成本's chart asks for 24 hours) and then never again.
   */
  eventRetentionMs: count,
  /**
   * How many SSE frames may wait on one slow browser before frames are dropped.
   *
   * The chain feeding it is one `bus.live()` per token from up to four concurrent
   * turns, so a tab that stops reading is the one case that grows without bound.
   * Dropping is safe — the panel re-reads its state on the next event — and the
   * loss is counted rather than silent.
   */
  streamBacklog: count,
  /** Unused by retrieval today; see `EmbeddingRef`. */
  embedding: EmbeddingRef,
  /**
   * model -> context window, and a `default` for anything unlisted.
   *
   * The rotation ceiling was the literal 200_000 for every model, true only of the
   * cheapest. Read off real turn logs: haiku-4-5 reports 200k, sonnet-5 and opus-5
   * report 1M, codex reports 272k. So the strong models rotated at 120k of a 1M
   * window — five times too early, throwing the cached prefix away each time.
   *
   * Both CLIs report their real window during a turn, and that wins over this table.
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
    /**
     * `host` or `host:port`, and nothing else.
     *
     * Every reader interpolates this into a URL, so an unchecked string is not an
     * address — it is the whole of the URL after the scheme. `evil.example/x?` turns
     * a probe carrying the sandbox API key into a request to somebody else's path,
     * and `user:pw@host` turns it into one carrying credentials. CodeQL called that
     * `js/file-access-to-http` and was right about the shape of it.
     */
    /**
     * Checked here rather than at the four call sites, because the four are not the
     * point: the fifth is. A value that cannot be a URL fragment cannot be misused
     * as one by a reader added next month.
     */
    server: z
      .string()
      .min(1)
      .regex(
        /^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9._-]+)(?::\d{1,5})?$/,
        "sandbox.server 只能是 host 或 host:port，不能带协议、路径、查询或凭据",
      ),
    apiKey: z.string(),
  }),
  dataDir: z.string().min(1),
  /**
   * Where the ticked skills are staged for the sandboxes to mount.
   *
   * Not under `dataDir`: the sandbox server mounts only host paths on its own
   * `allowed_host_paths` allowlist, whose default is `/var/tmp/orch-cache`.
   */
  /**
   * **Under `$HOME` on macOS, and that is not cosmetic.** Docker there runs in a
   * VM, so `/var/tmp` inside the VM is the VM's own — binding it *succeeds* and
   * hands the container an empty directory. Measured: 179 skills on the host, `ls`
   * inside returns 0, and every agent had run with no skills since ADR 006.
   *
   * Changing it means the server's `allowed_host_paths` must name the new path.
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
  // fallow-ignore-next-line security-sink -- this is the refusal text shown when someone tries to set `sandbox.apiKey` through the settings API, not a key. It is a deny-list entry; no value is stored or sent.
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

const settingDenial = (path: string): string | undefined =>
  Object.entries(SETTING_DENIALS).find(([deniedPath]) => deniedPath === path)?.[1];

/**
 * One path/value write, with both its RPC type and runtime check derived from ConfigSchema.
 *
 * The assertion is the only bridge TypeScript needs: runtime strings cannot preserve
 * which Map entry supplied which schema. The transform proves that relationship before
 * producing SettingWrite; every HTTP, database and browser write uses this same schema.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Zod cannot infer a union assembled from a runtime dotted path
export const SettingWriteSchema = SettingInput.transform((input, ctx): SettingWrite => {
  const denied = settingDenial(input.path);
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the path-selected schema above proves this correlated union at runtime
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
