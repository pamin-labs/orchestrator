import { join } from "node:path";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import type { DB } from "../db.ts";
import { runResource, type ResourceDef } from "./lease.ts";

/**
 * The deterministic gate: build, test, lint, typecheck, secret scan.
 *
 * It runs before any LLM review and its exit code is the whole verdict. This is
 * the layer that actually stops bad work — the LLM reviewers above it exist to
 * judge coverage and consistency, which a compiler cannot, and they are never
 * asked to re-check what a gate already checked.
 */

export interface GateResult {
  name: string;
  pass: boolean;
  exitCode: number;
  /** Lines the agent needs to fix, already extracted and capped. */
  errorLines: string[];
  logPath?: string;
}

export interface GateOutcome {
  pass: boolean;
  results: GateResult[];
  /** Compact feedback for the rejection delta. Never the whole log. */
  feedback: string;
}

/**
 * Which gates a project runs. Declared in `project.config_json` as
 * `{"gates": ["test", "lint"]}` — resource names, so gates go through the same
 * validated templates as everything else and an agent still cannot invent one.
 */
export function gatesFor(db: DB, projectId: number): string[] {
  const row = db
    .query<{ config_json: string }, [number]>("SELECT config_json FROM project WHERE id = ?")
    .get(projectId);
  try {
    const cfg = JSON.parse(row?.config_json ?? "{}");
    const gates = cfg.gates;
    return Array.isArray(gates) ? gates.filter((g: unknown) => typeof g === "string") : [];
  } catch {
    return [];
  }
}

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
      },
      [string]
    >("SELECT * FROM resource WHERE name = ?")
    .get(name);
  if (!r) return null;
  let argSchema: ResourceDef["argSchema"] = {};
  try {
    argSchema = JSON.parse(r.arg_schema_json);
  } catch {}
  return {
    name: r.name,
    template: r.template,
    concurrency: r.concurrency,
    argSchema,
    errorRegex: r.error_regex ?? undefined,
    cwd: r.cwd ?? undefined,
  };
}

export interface RunGatesOptions {
  db: DB;
  projectId: number;
  cwd: string;
  dataDir: string;
  sliceId: number;
  /** Injected in tests. */
  run?: typeof runResource;
  timeoutMs?: number;
}

/**
 * Run every gate, in order, and stop at the first failure.
 *
 * Stopping early is deliberate: a failing typecheck makes the test run's output
 * noise, and the agent only needs the first real reason.
 */
export async function runGates(opts: RunGatesOptions): Promise<GateOutcome> {
  const names = gatesFor(opts.db, opts.projectId);
  const run = opts.run ?? runResource;
  const results: GateResult[] = [];

  if (names.length === 0) {
    // No gates configured is not a pass. A project with nothing deterministic to
    // check has no floor under its LLM reviewers, and the boss should know.
    return {
      pass: false,
      results,
      feedback:
        'no gates are configured for this project. Add resource names to project config_json, e.g. {"gates":["test"]}.',
    };
  }

  // A worktree with its own node_modules is a gate failure waiting to happen, and
  // it fails as something else: `playwright is not installed` when the main
  // checkout installed it an hour ago. Measured — one group filed a blocker with
  // the right diagnosis and the boss had to act on it. Say it here, once, in the
  // words of the fix.
  const nm = join(opts.cwd, "node_modules");
  if (existsSync(nm) && !lstatSync(nm).isSymbolicLink()) {
    return {
      pass: false,
      results: [],
      feedback:
        `${opts.cwd}/node_modules is a real directory, not the symlink to the main checkout. ` +
        `It will be missing anything installed since it was created, and the gate that trips on that ` +
        `reports a missing package rather than a stale tree. Fix: rm -rf that directory and ` +
        `symlink the main checkout's in its place.`,
    };
  }

  const logDir = join(opts.dataDir, "gates");
  mkdirSync(logDir, { recursive: true });

  for (const name of names) {
    const def = loadResource(opts.db, name);
    if (!def) {
      results.push({ name, pass: false, exitCode: 127, errorLines: [`unknown gate resource ${name}`] });
      break;
    }
    const logPath = join(logDir, `${opts.sliceId}-${name}.log`);
    const out = await run(def, {}, { cwd: opts.cwd, logPath, timeoutMs: opts.timeoutMs });
    if (!("digest" in out)) {
      results.push({ name, pass: false, exitCode: 126, errorLines: [out.error] });
      break;
    }
    const pass = out.exitCode === 0;
    results.push({
      name,
      pass,
      exitCode: out.exitCode,
      errorLines: out.digest.errorLines.length ? out.digest.errorLines : out.digest.tail.slice(-20),
      logPath,
    });
    if (!pass) break;
  }

  const pass = results.length > 0 && results.every((r) => r.pass);
  return { pass, results, feedback: formatFeedback(results) };
}

function formatFeedback(results: GateResult[]): string {
  const failed = results.filter((r) => !r.pass);
  if (failed.length === 0) return results.map((r) => `${r.name}: pass`).join("\n");
  return failed
    .map(
      (r) =>
        // Deduped: a failing suite repeats the same assertion once per case, and
        // twenty identical lines is twenty lines the agent re-reads every round for
        // one fact. The full log is on disk and deliberately not here.
        `${r.name}: exit ${r.exitCode}\n${[...new Set(r.errorLines)].slice(0, 20).join("\n")}` +
        (r.logPath ? `\n(full log: ${r.logPath})` : ""),
    )
    .join("\n\n");
}

/** Merge a gate verdict into `slice.gates_json` without losing the other layers. */
export function recordGate(db: DB, sliceId: number, layer: string, verdict: "pass" | "fail"): void {
  const row = db
    .query<{ gates_json: string }, [number]>("SELECT gates_json FROM slice WHERE id = ?")
    .get(sliceId);
  let gates: Record<string, string> = {};
  try {
    gates = JSON.parse(row?.gates_json ?? "{}");
  } catch {}
  gates[layer] = verdict;
  db.run("UPDATE slice SET gates_json = ? WHERE id = ?", [JSON.stringify(gates), sliceId]);
}

export function gateState(db: DB, sliceId: number): Record<string, string> {
  const row = db
    .query<{ gates_json: string }, [number]>("SELECT gates_json FROM slice WHERE id = ?")
    .get(sliceId);
  try {
    return JSON.parse(row?.gates_json ?? "{}");
  } catch {
    return {};
  }
}
