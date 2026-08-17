import { resolve as resolvePath, relative, isAbsolute } from "node:path";
import { z } from "zod";
import type { Invalid, Result } from "./util/validate.ts";
import type { DB } from "../platform/persistence/database.ts";
import { jsonOr } from "../contracts/json.ts";

/**
 * A lease runs in the group's own sandbox, so this is no longer the host's only
 * opening — it is the agent's only interface. The reason inverted, the rules did
 * not (hard constraint 2). Two structural defences, not one:
 *
 *  1. A resource is a *template* from config. An agent picks a name and passes
 *     args; it can never supply a command.
 *  2. The template is tokenised into argv once and spawned WITHOUT a shell, so
 *     shell metacharacters in an arg are inert. Injection is not filtered, it
 *     is impossible.
 *
 * Arg schemas still exist — not to stop injection, but to stop a valid-looking
 * arg from pointing somewhere it should not (path traversal, unknown target).
 */

const ArgSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("enum"), values: z.array(z.string()).min(1) }),
  // `root` is a path inside the container. Existence cannot be checked on the
  // host; resources that need it run `test -e` in their sandbox template.
  z.object({ type: z.literal("path"), root: z.string() }),
  z.object({ type: z.literal("string"), pattern: z.string(), maxLength: z.number().int().positive().optional() }),
  z.object({ type: z.literal("int"), min: z.number().optional(), max: z.number().optional() }),
  z.object({ type: z.literal("bool") }),
]);
type ArgSpec = z.infer<typeof ArgSpecSchema>;
const ResourceArgsSchema = z.record(z.string(), ArgSpecSchema);

const LeaseArgSchema = z.union([z.string(), z.number(), z.boolean()]);
type LeaseArg = z.infer<typeof LeaseArgSchema>;
export const LeaseArgsSchema = z.record(z.string(), LeaseArgSchema);
export type LeaseArgs = z.infer<typeof LeaseArgsSchema>;

export interface ResourceDef {
  name: string;
  /** e.g. `bun test {file}` — tokenised, never handed to a shell. */
  template: string;
  concurrency: number;
  argSchema: z.infer<typeof ResourceArgsSchema>;
  /** Lines matching this are lifted into the digest. */
  errorRegex?: string;
  /**
   * Where the command runs, inside the container. Nothing writes it — the column
   * exists, `postProject` never sets it, and every caller falls through to
   * `/work`. Kept because a monorepo package will want it, and documented as a
   * container path because that is exactly how `grp.worktree` went wrong: a
   * column nothing wrote, read in four places, and the first host path anyone
   * put in it would have been silently unreachable.
   */
  cwd?: string;
  /** Pool names. One global slot count cannot fit a browser and a typecheck. */
  tags?: string[];
}

export interface ResolvedCommand {
  argv: string[];
  cwd?: string;
}

/**
 * The resource row as a `ResourceDef`.
 *
 * There were three of these — `gate.ts`, `api/orch/lease.ts`, `executor.ts` —
 * and they did not agree on what a broken column means. `arg_schema_json` was
 * defaulted to `{}` in two and parsed unguarded in the third, which is the one
 * reached by `POST /orch/v1/lease`: a malformed row there threw out of the handler
 * and reached the agent as a 500 with a JSON syntax error in it, where the other
 * two would have refused the call politely. `tags_json` was read by exactly one
 * of the three, and nothing read the result.
 *
 * `{}` rather than a throw, everywhere, because an empty schema is a boundary
 * that refuses every argument (硬约束 2) — the safe end of the failure, and the
 * one the two majority copies already picked.
 */
export function loadResource(db: DB, name: string): ResourceDef | null {
  const r = db
    .query<
      {
        name: string;
        template: string;
        concurrency: number;
        arg_schema_json: string;
        error_regex: string | null;
        cwd: string | null;
        tags_json: string | null;
      },
      [string]
    >("SELECT * FROM resource WHERE name = ?")
    .get(name);
  if (!r) return null;
  return {
    name: r.name,
    template: r.template,
    concurrency: r.concurrency,
    argSchema: jsonOr(r.arg_schema_json, ResourceArgsSchema, {}),
    ...(r.error_regex === null ? {} : { errorRegex: r.error_regex }),
    ...(r.cwd === null ? {} : { cwd: r.cwd }),
    tags: jsonOr(r.tags_json, z.array(z.string()), []),
  };
}

/** Split a template into argv tokens, honouring quotes. No shell involved. */
export function tokenize(template: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of template) {
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (!quote && (ch === '"' || ch === "'")) {
      quote = ch;
      has = true;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      appendToken(out, cur, has);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
  }
  appendToken(out, cur, has);
  return out;
}

function appendToken(tokens: string[], value: string, quoted: boolean): void {
  if (quoted || value) tokens.push(value);
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Substitute validated args into the template's argv.
 *
 * Every placeholder must have a schema entry and a value; every supplied arg
 * must appear in the template. Both directions are checked so a typo cannot
 * silently drop or smuggle an argument.
 */
export function resolveLease(def: ResourceDef, args: LeaseArgs): Result<ResolvedCommand> {
  const tokens = tokenize(def.template);
  if (tokens.length === 0) return { ok: false, error: `resource ${def.name} has an empty template` };

  const used = new Set<string>();
  const argv: string[] = [];

  for (const token of tokens) {
    PLACEHOLDER.lastIndex = 0;
    if (!PLACEHOLDER.test(token)) {
      argv.push(token);
      continue;
    }
    PLACEHOLDER.lastIndex = 0;
    let failure: Invalid | null = null;
    const replaced = token.replace(PLACEHOLDER, (_m, name: string) => {
      const spec = def.argSchema[name];
      if (!spec) {
        failure ??= { ok: false, error: `template references {${name}} but no schema declares it` };
        return "";
      }
      const raw = args[name];
      if (raw === undefined) {
        failure ??= { ok: false, error: `missing arg ${name}` };
        return "";
      }
      const v = validateArg(name, spec, raw);
      if (!v.ok) {
        failure ??= v;
        return "";
      }
      used.add(name);
      return v.value;
    });
    if (failure) return failure;
    argv.push(replaced);
  }

  const extra = Object.keys(args).filter((k) => !used.has(k));
  if (extra.length) {
    // An arg the template never consumes is either a typo or an attempt to
    // sneak something past. Either way it is a hard error, not a warning.
    return { ok: false, error: `unused args: ${extra.join(", ")}` };
  }
  return { ok: true, argv, ...(def.cwd === undefined ? {} : { cwd: def.cwd }) };
}

/**
 * One argument, as a zod schema built from the resource's own spec.
 *
 * The spec is data — the boss writes it into the `resource` table — so the
 * schema is built per call rather than declared. What that buys over the hand
 * written checks it replaces is not brevity, it is that coercion and refusal are
 * one decision: `int` used to accept anything `Number()` liked, so `"3 "`, `""`
 * and `true` all became integers on the way to a command line.
 *
 * The messages are kept verbatim. An agent reads them and has to correct itself
 * from them, so "must be one of: a, b" beats zod's "Invalid option".
 */
function argSchema(name: string, spec: ArgSpec): z.ZodType<string> {
  switch (spec.type) {
    case "enum":
      return z.enum(spec.values, { error: `${name} must be one of: ${spec.values.join(", ")}` }).transform(String);
    case "int": {
      // Not `z.coerce.number()`: that is `Number()`, which says `true` is 1 and
      // `""` is 0. A checkbox and a blank field would both reach a command line
      // as a number somebody chose. A number, or a string that is entirely a
      // number — nothing else.
      let bounded = z.number().int(`${name} must be an integer`);
      if (spec.min !== undefined) bounded = bounded.min(spec.min, `${name} must be >= ${spec.min}`);
      if (spec.max !== undefined) bounded = bounded.max(spec.max, `${name} must be <= ${spec.max}`);
      return z
        .union(
          [
            z.number(),
            z
              .string()
              .regex(/^-?\d+$/, `${name} must be an integer`)
              .transform(Number),
          ],
          {
            error: `${name} must be an integer`,
          },
        )
        .pipe(bounded)
        .transform(String);
    }
    case "bool":
      // Not `z.coerce.boolean()`: that treats every non-empty string as true, so
      // "false" and "no" would both arrive as `true` on a command line. The two
      // words and the two booleans, and nothing else.
      return z
        .union([z.boolean(), z.literal("true"), z.literal("false")], { error: `${name} must be true or false` })
        .transform((v) => String(v));
    case "string": {
      let t = z.string({ error: `${name} must be a string` });
      if (spec.maxLength) t = t.max(spec.maxLength, `${name} is longer than ${spec.maxLength}`);
      return t.regex(new RegExp(spec.pattern), `${name} does not match ${spec.pattern}`);
    }
    case "path":
      // The one case no schema library covers, and the one that matters most:
      // whether a path stays inside a root is a question about two paths, and the
      // answer is `relative()`. Escaping is the whole risk — `../../etc/passwd`,
      // an absolute path, a `..` chain shaped like a symlink.
      return z
        .string({ error: `${name} must be a path` })
        .refine((v) => !v.includes("\0"), `${name} contains a null byte`)
        .transform((v) => {
          const root = resolvePath(spec.root);
          return { root, abs: isAbsolute(v) ? resolvePath(v) : resolvePath(root, v) };
        })
        .refine(({ root, abs }) => {
          const rel = relative(root, abs);
          return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
        }, `${name} must stay inside ${spec.root}`)
        .transform(({ abs }) => abs);
  }
}

function validateArg(name: string, spec: ArgSpec, raw: LeaseArg): { ok: true; value: string } | Invalid {
  const r = argSchema(name, spec).safeParse(raw);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, error: r.error.issues[0]?.message ?? `${name} is invalid` };
}

export interface LeaseDigest {
  exitCode: number;
  /** Lines lifted by errorRegex, deduped and capped. */
  errorLines: string[];
  /** Last N lines of combined output. */
  tail: string[];
  truncated: boolean;
  text: string;
}

const TAIL_LINES = 200;
const MAX_ERROR_LINES = 40;

/**
 * A build log is megabytes; pasting it back would burn half a context window.
 * The agent gets three things and can fetch the rest with `orch lease log`.
 */
export function digestOutput(exitCode: number, output: string, errorRegex?: string, logPath?: string): LeaseDigest {
  const lines = output.split("\n").map((l) => l.trimEnd());
  while (lines.length && lines.at(-1) === "") lines.pop();
  const tail = lines.slice(-TAIL_LINES);
  const truncated = lines.length > tail.length;
  const errorLines = extractErrorLines(lines, errorRegex);
  const parts = [`exit ${exitCode}`];
  if (errorLines.length) parts.push(`\n## errors (${errorLines.length})\n${errorLines.join("\n")}`);
  parts.push(`\n## tail (${tail.length}${truncated ? ` of ${lines.length}` : ""} lines)\n${tail.join("\n")}`);
  // The verb, not the path: `logPath` is on the orchestrator's disk and this text
  // is read inside a container, where that path does not exist. It was printed
  // next to the verb "for reference" and reads as something to open.
  if (truncated && logPath) parts.push(`\nfull log: orch lease log <id> --grep TEXT`);

  return { exitCode, errorLines, tail, truncated, text: parts.join("\n") };
}

function extractErrorLines(lines: string[], pattern?: string): string[] {
  if (!pattern) return [];
  const regex = new RegExp(pattern);
  const errors = new Set<string>();
  for (const line of lines) {
    if (regex.test(line) && line.trim()) errors.add(line.trim());
    if (errors.size >= MAX_ERROR_LINES) break;
  }
  return [...errors];
}

export interface RunOutcome {
  exitCode: number;
  digest: LeaseDigest;
  logPath?: string;
}

/**
 * Run a resolved resource. Shared by `orch lease` and by the deterministic gate,
 * so both get the same three-part digest and the same off-context log.
 *
 * No shell: argv straight to spawn, which is what makes an arg's shell
 * metacharacters inert rather than filtered.
 */
/** 124 is what `timeout(1)` returns, so the number already means this. */
export const LEASE_TIMEOUT_CODE = 124;

/** Where a group's checkout lives. Mirrors mech/sandbox.ts; importing it here would be a cycle. */
const WORK_DEFAULT = "/work";

/**
 * Runs one resolved command. The sandbox supplies this; nothing runs on the host.
 *
 * A timeout is the caller's, not ours: the exec API enforces one server-side, so
 * there is no SIGTERM-then-SIGKILL dance left to write.
 */
export type ResourceExec = (
  argv: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<{ code: number; out: string }>;

export async function runResource(
  def: ResourceDef,
  args: LeaseArgs,
  opts: {
    exec: ResourceExec;
    cwd?: string;
    logPath?: string;
    timeoutMs?: number;
  },
): Promise<RunOutcome | Invalid> {
  const resolved = resolveLease(def, args);
  if (!resolved.ok) return resolved;

  const cwd = opts.cwd ?? resolved.cwd ?? WORK_DEFAULT;
  const limit = opts.timeoutMs ?? 0;
  const { code, out: output } = await opts.exec(resolved.argv, { cwd, ...(limit ? { timeoutMs: limit } : {}) });
  if (opts.logPath) await Bun.write(opts.logPath, output);

  // 124 is what the exec API's own timeout reports, and what `timeout(1)` has
  // always meant. Either way the lease slot is what a hang costs, and slots are
  // global and few: one wedged build stops every group from gating again.
  if (limit && code === LEASE_TIMEOUT_CODE) {
    const mins = Math.round(limit / 60_000);
    const base = digestOutput(LEASE_TIMEOUT_CODE, output, def.errorRegex, opts.logPath);
    return {
      exitCode: LEASE_TIMEOUT_CODE,
      digest: {
        ...base,
        text:
          `exit ${LEASE_TIMEOUT_CODE}: killed after ${mins} min (lease timeout). It either ` +
          `hangs, or needs a leaseTimeoutMs above ${mins} min.\n${base.text}`,
      },
      ...(opts.logPath === undefined ? {} : { logPath: opts.logPath }),
    };
  }
  return {
    exitCode: code,
    digest: digestOutput(code, output, def.errorRegex, opts.logPath),
    ...(opts.logPath === undefined ? {} : { logPath: opts.logPath }),
  };
}
