import { resolve as resolvePath, relative, isAbsolute } from "node:path";
import type { Invalid, Result } from "./validate.ts";

/**
 * The Runner runs on the host with real privileges while agents sit in a
 * sandbox, so this module is the sandbox's only opening. Two structural
 * defences, not one:
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
  | { type: "path"; root: string; mustExist?: boolean }
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
  cwd?: string;
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
  if (truncated && logPath) parts.push(`\nfull log: orch lease log <id> --grep RE  (${logPath})`);

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

export async function runResource(
  def: ResourceDef,
  args: Record<string, unknown>,
  opts: { cwd?: string; logPath?: string; timeoutMs?: number } = {},
): Promise<RunOutcome | Invalid> {
  const resolved = resolveLease(def, args);
  if (!resolved.ok) return resolved;

  const proc = Bun.spawn(resolved.argv, {
    cwd: opts.cwd ?? resolved.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  // Without this a hung command holds the lease slot forever, and lease slots are
  // global and few: one wedged build stops every group from ever gating again.
  let timedOut = false;
  const limit = opts.timeoutMs ?? 0;
  const timer = limit
    ? setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        // SIGTERM is a request. A build that ignores it still has to die.
        setTimeout(() => proc.kill("SIGKILL"), 5_000);
      }, limit)
    : undefined;

  const [so, se] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);
  const output = so + se;
  if (opts.logPath) await Bun.write(opts.logPath, output);
  if (timedOut) {
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
  return { exitCode, digest: digestOutput(exitCode, output, def.errorRegex, opts.logPath), logPath: opts.logPath };
}
