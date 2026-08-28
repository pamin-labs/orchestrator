import { join } from "node:path";
import { activeTracer } from "../platform/observability/traces.ts";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import type { DB } from "../platform/persistence/database.ts";
import { projectConfig } from "./util/rows.ts";
import { loadResource, type ResourceDef, type ResourceExec, runResource } from "./lease.ts";
import { valueOr } from "../contracts/json.ts";
import { eq } from "drizzle-orm";
import { slice } from "../platform/persistence/schema.ts";

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
export async function gatesFor(db: DB, projectId: number): Promise<string[]> {
  const config = await projectConfig(db, projectId);
  return (config.gates ?? []).flatMap((g) => GateName.safeParse(g).data ?? []);
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
  // The gates run one after another, each bounded by the lease timeout, and the
  // whole sequence is what a slice waits on. `lease.run` times each one; this is
  // the parent that says whether "gating is slow" is one gate or all of them.
  return activeTracer().startActiveSpan("gate.run", async (span) => {
    try {
      return await runGatesInner(opts);
    } finally {
      span.end();
    }
  });
}

interface RunOneOptions {
  run: typeof runResource;
  exec: ResourceExec;
  cwd: string;
  logPath: string;
  timeoutMs?: number;
}

/**
 * One gate, run the way every gate is run.
 *
 * Extracted because a second caller needs *exactly* this and not something like
 * it: `postSetup` proves a gate an agent proposed by running it, and a proof that
 * went through a different path would be a proof about a different command. The
 * lease timeout, the argv tokenisation, the error-line digest and the off-context
 * log are the parts that must be shared, not just the spawn.
 */
async function runOneGate(def: ResourceDef, opts: RunOneOptions): Promise<GateResult> {
  const out = await opts.run(
    def,
    {},
    {
      exec: opts.exec,
      cwd: opts.cwd,
      logPath: opts.logPath,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    },
  );
  if (!("digest" in out)) return { name: def.name, pass: false, exitCode: 126, errorLines: [out.error] };
  return {
    name: def.name,
    pass: out.exitCode === 0,
    exitCode: out.exitCode,
    errorLines: out.digest.errorLines.length ? out.digest.errorLines : out.digest.tail.slice(-20),
    logPath: opts.logPath,
  };
}

/**
 * Run a gate that is not registered yet, to find out whether it is one.
 *
 * The second half of `postSetup`'s check. A command the repository declared is
 * accepted on that declaration; a command it did not declare has to earn its
 * place by running — which is stronger evidence than a declaration, and needs no
 * table of languages to produce. `rebar3 eunit` in a repository with no CI is the
 * case this exists for.
 */
export async function proveGate(
  gate: { name: string; template: string; errorRegex?: string },
  opts: { exec: ResourceExec; cwd: string; dataDir: string; timeoutMs?: number },
): Promise<GateResult> {
  const logDir = join(opts.dataDir, "gates");
  mkdirSync(logDir, { recursive: true });
  return runOneGate(
    {
      name: gate.name,
      template: gate.template,
      argSchema: {},
      // Same row `registerGates` would write, so the proof runs the command the
      // registration will: one at a time per repository, no arguments.
      concurrency: 1,
      ...(gate.errorRegex === undefined ? {} : { errorRegex: gate.errorRegex }),
      tags: ["repo"],
    },
    {
      run: runResource,
      exec: opts.exec,
      cwd: opts.cwd,
      logPath: join(logDir, `setup-${gate.name}.log`),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    },
  );
}

async function runGatesInner(opts: RunGatesOptions): Promise<GateOutcome> {
  const names = await gatesFor(opts.db, opts.projectId);
  const run = opts.run ?? runResource;
  const results: GateResult[] = [];

  if (names.length === 0) {
    // `runDeterministicReview` decides what an empty list means — a question for
    // the boss when nobody has looked, a recorded `none` when they have — and
    // never calls this with one. Anything else that does is asking the wrong
    // layer, so it gets the same answer it always did: not a pass.
    return { pass: false, results, feedback: "no gates are configured for this project" };
  }

  const logDir = join(opts.dataDir, "gates");
  mkdirSync(logDir, { recursive: true });

  for (const name of names) {
    const def = await loadResource(opts.db, name);
    if (!def) {
      results.push({ name, pass: false, exitCode: 127, errorLines: [`unknown gate resource ${name}`] });
      break;
    }
    const result = await runOneGate(def, {
      run,
      exec: opts.exec,
      cwd: opts.cwd,
      logPath: join(logDir, `${opts.sliceId}-${name}.log`),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    results.push(result);
    if (!result.pass) break;
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
/**
 * Six words, and only one of them is a verdict on the slice.
 *
 * `blind` and `partial` are what the discriminator found — nothing covered, or
 * some of it — `new` is what the boundary scan found, and `none` is a layer that
 * had nothing to run, which a project with no gate chose. The panel draws only the layers in
 * `STOPS` and reddens on `"fail"` alone, so the other two are evidence without a
 * colour — and a pull request that says `gate: none` has said something true that
 * `gate: pass` would not have.
 */
export async function recordGate(
  db: DB,
  sliceId: number,
  layer: string,
  verdict: "pass" | "fail" | "blind" | "partial" | "none" | "new",
): Promise<void> {
  const gates = await gateState(db, sliceId);
  gates[layer] = verdict;
  await db.update(slice).set({ gates_json: gates }).where(eq(slice.id, sliceId));
}

export async function gateState(db: DB, sliceId: number): Promise<Record<string, string>> {
  const [row] = await db.select({ gates_json: slice.gates_json }).from(slice).where(eq(slice.id, sliceId));
  return valueOr(row?.gates_json, GateState, {});
}
