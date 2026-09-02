import type { Json } from "../contracts/json.ts";
import type { TurnHandlers, TurnSpec } from "./claude.ts";
import { shq } from "../platform/process/shell.ts";
import { type AskResult, type AskSpec, promptPath, type Usage } from "./providers/contract.ts";

/**
 * The fields this reads, rather than a whole `TurnSpec`.
 *
 * A one-prompt `ask` has no stable prefix and no session, and asking it to
 * invent them to reuse the streaming, logging and abort plumbing would be the
 * reason it went and wrote its own instead.
 */
export type Streamable = Pick<TurnSpec, "runner" | "cwd" | "timeoutMs" | "env" | "signal" | "logPath">;

export async function runLineStream(
  spec: Streamable,
  cmd: string,
  registerAbort: TurnHandlers["onAbort"],
  onLine: (raw: string) => Json | undefined,
): Promise<{ code: number; err: string }> {
  const controller = new AbortController();
  registerAbort?.(() => controller.abort());
  const signal = spec.signal ? AbortSignal.any([spec.signal, controller.signal]) : controller.signal;
  const log = spec.logPath ? Bun.file(spec.logPath).writer() : undefined;
  const stream = spec.runner.lines(cmd, {
    cwd: spec.cwd,
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    ...(spec.env ? { env: spec.env } : {}),
    signal,
  });

  try {
    while (true) {
      const step = await stream.next();
      if (step.done) return step.value;
      const record = onLine(step.value);
      if (record !== undefined) await log?.write(`${JSON.stringify(record)}\n`);
    }
  } finally {
    await log?.end();
  }
}

/**
 * One prompt in, one answer out, for whichever CLI names its own argv.
 *
 * The two providers differ in the flags and in how they spell an answer, and in
 * nothing else: the prompt goes to a file because the exec API has no stdin, the
 * command is the same shape a turn sends, and the exit code and stderr come back
 * for the caller to report in its own words. Written once, because the last time
 * this half was written a second time it grew a `; exit $rc` that ended the
 * shared bash session and every call came back empty.
 */
export async function askVia(
  spec: AskSpec,
  argv: string[],
  read: (out: string) => { text: string; usage?: Usage },
): Promise<AskResult> {
  const file = promptPath();
  await spec.runner.put(file, spec.prompt);
  let out = "";
  const end = await runLineStream(
    spec,
    `${argv.map(shq).join(" ")} < ${file}; rc=$?; rm -f ${file}; exit $rc`,
    undefined,
    (raw) => {
      out += `${raw}\n`;
      return undefined;
    },
  );
  return { ...read(out.trim()), code: end.code, err: end.err };
}
