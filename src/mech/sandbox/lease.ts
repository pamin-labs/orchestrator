import { resolve as resolvePath, relative, isAbsolute } from "node:path";
import type { Invalid, Result } from "../flow/validate.ts";

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

export type ArgSpec =
  | { type: "enum"; values: string[] }
  // `root` is confined against, and it is a path *inside the container* — the
  // resolved value is substituted into a template that runs there. `mustExist`
  // used to sit here too, checked by nothing: the check it implies would be a
  // host `existsSync` against a container path, which is the pre-005 mistake this
  // file is otherwise free of. If a resource ever needs it, it is a `test -e` in
  // the sandbox, not a field.
  | { type: "path"; root: string }
  | { type: "string"; pattern: string; maxLength?: number }
  | { type: "int"; min?: number; max?: number }
  | { type: "bool" };

export interface ResourceDef {
  name: string;
  /** e.g. `bun test {file}` — tokenised, never handed to a shell. */
  template: string;
  concurrency: number;
  argSchema: Record<string, ArgSpec>;
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

/** Split a template into argv tokens, honouring quotes. No shell involved. */
export function tokenize(template: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of template) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Substitute validated args into the template's argv.
 *
 * Every placeholder must have a schema entry and a value; every supplied arg
 * must appear in the template. Both directions are checked so a typo cannot
 * silently drop or smuggle an argument.
 */
export function resolveLease(
  def: ResourceDef,
  args: Record<string, unknown>,
): Result<ResolvedCommand> {
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
      if (!(name in args)) {
        failure ??= { ok: false, error: `missing arg ${name}` };
        return "";
      }
      const v = validateArg(name, spec, args[name]);
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
  return { ok: true, argv, cwd: def.cwd };
}

function validateArg(
  name: string,
  spec: ArgSpec,
  raw: unknown,
): { ok: true; value: string } | Invalid {
  switch (spec.type) {
    case "enum": {
      const s = String(raw);
      if (!spec.values.includes(s)) {
        return { ok: false, error: `${name} must be one of: ${spec.values.join(", ")}` };
      }
      return { ok: true, value: s };
    }
    case "int": {
      const n = Number(raw);
      if (!Number.isInteger(n)) return { ok: false, error: `${name} must be an integer` };
      if (spec.min !== undefined && n < spec.min) {
        return { ok: false, error: `${name} must be >= ${spec.min}` };
      }
      if (spec.max !== undefined && n > spec.max) {
        return { ok: false, error: `${name} must be <= ${spec.max}` };
      }
      return { ok: true, value: String(n) };
    }
    case "bool": {
      if (raw === true || raw === "true") return { ok: true, value: "true" };
      if (raw === false || raw === "false") return { ok: true, value: "false" };
      return { ok: false, error: `${name} must be true or false` };
    }
    case "string": {
      const s = String(raw);
      if (spec.maxLength && s.length > spec.maxLength) {
        return { ok: false, error: `${name} is longer than ${spec.maxLength}` };
      }
      if (!new RegExp(spec.pattern).test(s)) {
        return { ok: false, error: `${name} does not match ${spec.pattern}` };
      }
      return { ok: true, value: s };
    }
    case "path": {
      const s = String(raw);
      if (s.includes("\0")) return { ok: false, error: `${name} contains a null byte` };
      const root = resolvePath(spec.root);
      const abs = isAbsolute(s) ? resolvePath(s) : resolvePath(root, s);
      const rel = relative(root, abs);
      // Escaping the root is the whole risk here: `../../etc/passwd`, an
      // absolute path, or a symlink-shaped `..` chain.
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        return { ok: false, error: `${name} must stay inside ${spec.root}` };
      }
      return { ok: true, value: abs };
    }
  }
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

export const TAIL_LINES = 200;
const MAX_ERROR_LINES = 40;

/**
 * A build log is megabytes; pasting it back would burn half a context window.
 * The agent gets three things and can fetch the rest with `orch lease log`.
 */
export function digestOutput(
  exitCode: number,
  output: string,
  errorRegex?: string,
  logPath?: string,
): LeaseDigest {
  const lines = output.split("\n").map((l) => l.trimEnd());
  while (lines.length && lines.at(-1) === "") lines.pop();

  const tail = lines.slice(-TAIL_LINES);
  const truncated = lines.length > tail.length;

  let errorLines: string[] = [];
  if (errorRegex) {
    const re = new RegExp(errorRegex);
    const seen = new Set<string>();
    for (const l of lines) {
      if (!re.test(l)) continue;
      const key = l.trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        errorLines.push(key);
      }
      if (errorLines.length >= MAX_ERROR_LINES) break;
    }
  }

  const parts = [`exit ${exitCode}`];
  if (errorLines.length) parts.push(`\n## errors (${errorLines.length})\n${errorLines.join("\n")}`);
  parts.push(
    `\n## tail (${tail.length}${truncated ? ` of ${lines.length}` : ""} lines)\n${tail.join("\n")}`,
  );
  // The verb, not the path: `logPath` is on the orchestrator's disk and this text
  // is read inside a container, where that path does not exist. It was printed
  // next to the verb "for reference" and reads as something to open.
  if (truncated && logPath) parts.push(`\nfull log: orch lease log <id> --grep TEXT`);

  return { exitCode, errorLines, tail, truncated, text: parts.join("\n") };
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
  args: Record<string, unknown>,
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
  const { code, out: output } = await opts.exec(resolved.argv, { cwd, timeoutMs: limit || undefined });
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
      logPath: opts.logPath,
    };
  }
  return { exitCode: code, digest: digestOutput(code, output, def.errorRegex, opts.logPath), logPath: opts.logPath };
}
