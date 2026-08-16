import { expect, test } from "bun:test";
import { buildStable } from "../src/prompt/assemble.ts";
import { buildArgv, runTurn, summarizeTool, trimForLog, type TurnRunner } from "../src/runtime/claude.ts";

const stable = buildStable({
  rolePrompt: "Engineer",
  model: "sonnet",
  allowedTools: ["Bash(orch *)", "Read", "Edit"],
  addDirs: ["/tmp/wt/g1"],
});

/**
 * A sandbox that replays canned stdout.
 *
 * The seam the adapter actually has now: it hands a command to a runner rather
 * than spawning, so the fake is a runner and not a fake `Bun.spawn`.
 */
function fakeRunner(
  lines: unknown[],
  opts: { err?: string; code?: number } = {},
): TurnRunner & { cmd: string; wrote: string } {
  const r: any = { cmd: "", wrote: "" };
  r.put = async (_p: string, data: string) => {
    r.wrote = data;
  };
  r.lines = async function* (cmd: string) {
    r.cmd = cmd;
    for (const l of lines) yield JSON.stringify(l);
    return { code: opts.code ?? 0, err: opts.err ?? "" };
  };
  return r;
}

test("argv resumes a session and never re-sends the delta as a system prompt", () => {
  const argv = buildArgv({ stable, prompt: "do S1", cwd: "/tmp", resumeSessionId: "abc" });
  expect(argv).toContain("--resume");
  expect(argv[argv.indexOf("--resume") + 1]).toBe("abc");
  // The delta travels on stdin only. If it ever shows up in argv the cache dies.
  expect(argv.join(" ")).not.toContain("do S1");
  const sysIdx = argv.indexOf("--append-system-prompt");
  expect(argv[sysIdx + 1]).toBe(stable.systemAppend);
});

test("a fresh session gets an explicit id so it can be recorded up front", () => {
  const argv = buildArgv({ stable, prompt: "x", cwd: "/tmp", newSessionId: "uuid-1" });
  expect(argv).toContain("--session-id");
  expect(argv).not.toContain("--resume");
});

test("summarizeTool clips to one line and never dumps the raw input", () => {
  const long = "x".repeat(500);
  const t = summarizeTool("Bash", { command: `echo ${long}` });
  expect(t.detail.length).toBeLessThan(100);
  expect(t.detail.startsWith("Bash: echo")).toBe(true);
  expect(summarizeTool("Edit", { file_path: "auth/mw.ts" }).detail).toBe("Edit: auth/mw.ts");
});

test("runTurn extracts usage, cost, rate limit and touched files", async () => {
  // Shapes taken from a real `claude -p --output-format stream-json` run.
  const lines = [
    { type: "system", subtype: "init", session_id: "sess-9", model: "sonnet" },
    { type: "system", subtype: "status", status: "requesting" },
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 1786554000 },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Edit", input: { file_path: "auth/mw.ts" } },
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "auth/mw.ts" } },
          { type: "text", text: "moved the check" },
        ],
      },
    },
    { type: "user", tool_use_result: { stdout: "ok", stderr: "", interrupted: false } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      terminal_reason: "completed",
      result: "moved the check",
      num_turns: 2,
      permission_denials: [{ tool: "Bash", command: "git push" }],
      usage: {
        input_tokens: 18,
        output_tokens: 164,
        cache_read_input_tokens: 89026,
        cache_creation_input_tokens: 153,
        output_tokens_details: { thinking_tokens: 83 },
      },
      modelUsage: { "claude-sonnet-5": { contextWindow: 200000 } },
    },
  ];

  const runner = fakeRunner(lines);
  {
    const seenText: string[] = [];
    const r = await runTurn(
      { stable, prompt: "do S1", cwd: "/tmp", resumeSessionId: "sess-9", runner },
      { onText: (t) => seenText.push(t) },
    );

    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("sess-9");
    expect(r.terminalReason).toBe("completed");
    expect(r.text).toBe("moved the check");
    expect(r.usage).toEqual({
      input: 18,
      output: 164,
      cacheRead: 89026,
      cacheCreate: 153,
      thinking: 83,
    });
    expect(r.contextWindow).toBe(200000);
    expect(r.filesTouched).toEqual(["auth/mw.ts"]);
    expect(r.rateLimit?.rateLimitType).toBe("five_hour");
    // Reported once, not twice, despite appearing in both stream_event and assistant.
    expect(r.toolSummaries.filter((t) => t.name === "Edit").length).toBe(1);
  }
});

test("a turn with no result line is a failure, not a silent success", async () => {
  // Dies without ever emitting `result`.
  const runner = fakeRunner([{ type: "system", subtype: "init", session_id: "s" }], {
    err: "boom: crashed",
    code: 1,
  });
  {
    const r = await runTurn({ stable, prompt: "x", cwd: "/tmp", resumeSessionId: "s", runner });
    expect(r.ok).toBe(false);
    expect(r.terminalReason).toBe("no_result");
    expect(r.text).toContain("boom");
  }
});

test("JSON-shaped malformed stream frames are ignored", async () => {
  const runner = fakeRunner([
    null,
    { type: "assistant", message: { content: [null] } },
    { type: "result", is_error: false, usage: { input_tokens: "not a number" } },
  ]);
  const r = await runTurn({ stable, prompt: "x", cwd: "/tmp", resumeSessionId: "s", runner });
  expect(r.ok).toBe(true);
  expect(r.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 });
});

test("the desk wall never shows a bare tool name", async () => {
  // content_block_start arrives before the input has streamed, so announcing it
  // would replace a useful line with just "Bash".
  const lines = [
    { type: "system", subtype: "init", session_id: "s" },
    {
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash", input: {} } },
    },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "orch task list" } }] },
    },
    { type: "result", subtype: "success", is_error: false, terminal_reason: "completed", usage: {} },
  ];
  const runner = fakeRunner(lines);
  {
    const announced: string[] = [];
    const r = await runTurn(
      { stable, prompt: "x", cwd: "/tmp", resumeSessionId: "s", runner },
      { onTool: (t) => announced.push(t.detail) },
    );
    expect(announced).toEqual(["Bash: orch task list"]);
    // And the placeholder is replaced, not duplicated.
    expect(r.toolSummaries.map((t) => t.detail)).toEqual(["Bash: orch task list"]);
  }
});

test("a turn log keeps the shape and drops the payload", () => {
  // 123 MB for ten requirements, and 90% of it was tool results: whole files, whole
  // diffs, whole test runs. Everything these logs are actually read for is shape —
  // rounds, tools, tokens, what failed — so results keep a head and a size.
  const line = {
    type: "user",
    message: {
      usage: { cache_read_input_tokens: 5 },
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "x".repeat(5000) },
        { type: "tool_use", name: "Bash", input: { command: "bun test" } },
      ],
    },
  };
  const out = trimForLog(line) as any;
  expect(out.message.usage.cache_read_input_tokens).toBe(5);
  expect(out.message.content[0].content).toContain("[5000 chars omitted]");
  expect(out.message.content[0].content.length).toBeLessThan(500);
  expect(out.message.content[0].tool_use_id).toBe("t1");
  // The input says what the agent was trying to do, and it is small. Kept whole.
  expect(out.message.content[1].input.command).toBe("bun test");
  // The field the payload is actually in: 90% of a real turn's file, against 0%
  // for the block inside `content`. Trimming only the latter cut 17%.
  const big = trimForLog({ type: "user", tool_use_result: { stdout: "z".repeat(9000), interrupted: false } }) as any;
  expect(big.tool_use_result.stdout).toContain("[9000 chars omitted]");
  expect(big.tool_use_result.interrupted).toBe(false);

  // A short result is untouched: truncating it would only add noise.
  // `type` is on every line of the real stream; the fixture omitted it while the
  // parameter was `any`.
  expect(
    (trimForLog({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }) as any).message
      .content[0].content,
  ).toBe("ok");
});
