import { expect, test } from "bun:test";
import { buildStable } from "../src/prompt/assemble.ts";
import { buildArgv, runTurn } from "../src/runtime/codex.ts";

const stable = buildStable({
  rolePrompt: "You are the Engineer.",
  model: "gpt-5-codex",
  allowedTools: ["Bash(orch *)", "Read", "Edit"],
  settingsPath: "unused-by-codex",
  addDirs: ["/tmp/wt/g1"],
});

/** Real codex output, banner line and all. */
const LINES = [
  "Reading prompt from stdin...",
  JSON.stringify({ type: "thread.started", thread_id: "019ff72d-e984-7053" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "orch task claim 1" } }),
  JSON.stringify({ type: "item.completed", item: { type: "file_change", path: "auth/mw.ts" } }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "moved the check" } }),
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 27330,
      cached_input_tokens: 6912,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 2,
    },
  }),
];

function fakeSpawn(lines: string[], stderr = "") {
  return () => ({
    pid: 99,
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(lines.join("\n") + "\n");
        c.enqueue(bytes.slice(0, 21));
        c.enqueue(bytes.slice(21));
        c.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        if (stderr) c.enqueue(new TextEncoder().encode(stderr));
        c.close();
      },
    }),
    exited: Promise.resolve(0),
    kill() {},
  });
}

test("argv resumes a thread when there is one, and starts one otherwise", () => {
  const fresh = buildArgv({ stable, prompt: "p", cwd: "/tmp" });
  expect(fresh.slice(0, 2)).toEqual(["exec", "--json"]);
  const resumed = buildArgv({ stable, prompt: "p", cwd: "/tmp", resumeSessionId: "thread-7" });
  expect(resumed.slice(0, 4)).toEqual(["exec", "resume", "thread-7", "--json"]);
  expect(resumed).toContain("-m");
  expect(resumed[resumed.indexOf("-m") + 1]).toBe("gpt-5-codex");
});

test("the non-JSON banner does not derail the parse", async () => {
  const spawned = Bun.spawn;
  // @ts-expect-error swap in a fake child
  Bun.spawn = fakeSpawn(LINES);
  try {
    const r = await runTurn({ stable, prompt: "do S1", cwd: "/tmp" });
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("019ff72d-e984-7053");
    expect(r.text).toBe("moved the check");
  } finally {
    Bun.spawn = spawned;
  }
});

test("usage maps onto the same shape the claude adapter produces", async () => {
  const spawned = Bun.spawn;
  // @ts-expect-error swap in a fake child
  Bun.spawn = fakeSpawn(LINES);
  try {
    const r = await runTurn({ stable, prompt: "x", cwd: "/tmp" });
    expect(r.usage).toEqual({ input: 27330, output: 5, cacheRead: 6912, cacheCreate: 0, thinking: 2 });
    // codex reports tokens but not money; inventing a number here would be worse
    // than attributing cost from tokens upstream.
    expect(r.costUsd).toBe(0);
    expect(r.filesTouched).toEqual(["auth/mw.ts"]);
    expect(r.toolSummaries.map((t) => t.name)).toEqual(["command_execution", "file_change"]);
  } finally {
    Bun.spawn = spawned;
  }
});

test("an error item becomes a denial, so it escalates rather than vanishing", async () => {
  const spawned = Bun.spawn;
  // @ts-expect-error swap in a fake child
  Bun.spawn = fakeSpawn([
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "item.completed", item: { type: "error", message: "refused to write outside sandbox" } }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ]);
  try {
    const r = await runTurn({ stable, prompt: "x", cwd: "/tmp" });
    expect(r.permissionDenials.length).toBe(1);
    expect(JSON.stringify(r.permissionDenials[0])).toContain("outside sandbox");
  } finally {
    Bun.spawn = spawned;
  }
});

test("turn.failed is a failure with the reason kept", async () => {
  const spawned = Bun.spawn;
  // @ts-expect-error swap in a fake child
  Bun.spawn = fakeSpawn([
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "turn.failed", error: { message: "model not supported for this account" } }),
  ]);
  try {
    const r = await runTurn({ stable, prompt: "x", cwd: "/tmp" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("not supported");
  } finally {
    Bun.spawn = spawned;
  }
});

test("a child that says nothing at all fails loudly", async () => {
  const spawned = Bun.spawn;
  // @ts-expect-error swap in a fake child
  Bun.spawn = fakeSpawn(["Reading prompt from stdin..."], "codex: command failed\n");
  try {
    const r = await runTurn({ stable, prompt: "x", cwd: "/tmp" });
    expect(r.ok).toBe(false);
    expect(r.terminalReason).toBe("no_result");
    expect(r.text).toContain("command failed");
  } finally {
    Bun.spawn = spawned;
  }
});
