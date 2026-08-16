import type { Json } from "../contracts/json.ts";
import type { TurnHandlers, TurnSpec } from "./claude.ts";

export async function runLineStream(
  spec: TurnSpec,
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
