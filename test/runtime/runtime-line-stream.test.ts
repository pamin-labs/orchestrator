import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { buildStable } from "../../src/prompt/assemble.ts";
import type { TurnRunner, TurnSpec } from "../../src/runtime/claude.ts";
import { runLineStream } from "../../src/runtime/line-stream.ts";

test("line stream owns abort, logging, and runner completion", async () => {
  const logPath = `/tmp/orch-line-stream-${crypto.randomUUID()}.ndjson`;
  let runnerSignal: AbortSignal | undefined;
  const runner: TurnRunner = {
    put: async () => {},
    lines: async function* (_cmd, opts) {
      runnerSignal = opts.signal;
      yield "keep";
      yield "skip";
      return { code: 7, err: "tail" };
    },
  };
  const spec: TurnSpec = {
    stable: buildStable({ rolePrompt: "r", model: "m", allowedTools: [], addDirs: [] }),
    prompt: "p",
    cwd: "/tmp",
    logPath,
    runner,
  };

  try {
    const tail = await runLineStream(
      spec,
      "provider",
      (abort) => abort(),
      (raw) => (raw === "keep" ? { raw } : undefined),
    );

    expect(runnerSignal?.aborted).toBe(true);
    expect(tail).toEqual({ code: 7, err: "tail" });
    expect(await Bun.file(logPath).text()).toBe('{"raw":"keep"}\n');
  } finally {
    await unlink(logPath).catch(() => {});
  }
});
