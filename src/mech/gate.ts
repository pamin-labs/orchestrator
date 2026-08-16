import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import type { DB } from "../db.ts";
import { projectConfig } from "./util/rows.ts";
import { loadResource, type ResourceExec, runResource } from "./lease.ts";
import { jsonOr } from "../contracts/json.ts";

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

/** A resource name that can also safely name its on-disk gate log. */
export const GateName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[\w.-]+$/, "must use letters, digits, _, . or -");
const GateState = z.record(z.string(), z.string());

/**
 * Which gates a project runs. Declared in `project.config_json` as
 * `{"gates": ["test", "lint"]}` — resource names, so gates go through the same
 * validated templates as everything else and an agent still cannot invent one.
 */
export function gatesFor(db: DB, projectId: number): string[] {
  return (projectConfig(db, projectId).gates ?? []).flatMap((g) => GateName.safeParse(g).data ?? []);
}

export interface RunGatesOptions {
  db: DB;
  projectId: number;
  cwd: string;
  dataDir: string;
  sliceId: number;
  /** How to run a gate. The group's sandbox, or a fake in tests. */
  exec: ResourceExec;
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
        // Says which of the two it is. Gates are worked out from the first
        // group's clone (007 §2), so before that has happened "none configured"
        // means "not detected yet" and telling the boss to go and write them by
        // hand is sending them to do the system's job.
        "no gates are configured for this project. They are detected from the first group's clone; " +
        'if that has happened and found nothing, add resource names to project config_json, e.g. {"gates":["test"]}.',
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
    const out = await run(
      def,
      {},
      {
        exec: opts.exec,
        cwd: opts.cwd,
        logPath,
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      },
    );
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
        // No host path in here. `logPath` is on the orchestrator's disk and this
        // text is read inside a container, where opening it gets ENOENT — the
        // lease digest already learned to name the verb instead of the file.
        `${r.name}: exit ${r.exitCode}\n${[...new Set(r.errorLines)].slice(0, 20).join("\n")}` +
        (r.logPath ? `\n(the boss can open the full log from the slice page)` : ""),
    )
    .join("\n\n");
}

/** Merge a gate verdict into `slice.gates_json` without losing the other layers. */
export function recordGate(db: DB, sliceId: number, layer: string, verdict: "pass" | "fail"): void {
  const row = db.query<{ gates_json: string }, [number]>("SELECT gates_json FROM slice WHERE id = ?").get(sliceId);
  const gates = jsonOr(row?.gates_json, GateState, {});
  gates[layer] = verdict;
  db.run("UPDATE slice SET gates_json = ? WHERE id = ?", [JSON.stringify(gates), sliceId]);
}

export function gateState(db: DB, sliceId: number): Record<string, string> {
  const row = db.query<{ gates_json: string }, [number]>("SELECT gates_json FROM slice WHERE id = ?").get(sliceId);
  return jsonOr(row?.gates_json, GateState, {});
}
