import { expect, test } from "bun:test";
import { buildStable } from "../src/prompt/assemble.ts";
import type { TurnRunner } from "../src/runtime/claude.ts";
import { buildCodexArgv as buildArgv, runCodexTurn as runTurn, trimItem } from "../src/runtime/codex.ts";
import { z } from "zod";

const stable = buildStable({
  rolePrompt: "You are the Engineer.",
  model: "gpt-5-codex",
  allowedTools: ["Bash(orch *)", "Read", "Edit"],
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

/**
 * A sandbox that replays canned stdout.
 *
 * `wrote` is what the adapter put in the prompt file — the exec API has no
 * stdin, so that is where the delta travels now.
 */
function fakeRunner(lines: string[], stderr = ""): TurnRunner & { cmd: string; wrote: string } {
  const runner: TurnRunner & { cmd: string; wrote: string } = {
    cmd: "",
    wrote: "",
    put: async (_path, data) => {
      runner.wrote = data;
    },
    lines: async function* (cmd) {
      runner.cmd = cmd;
      for (const line of lines) yield line;
      return { code: stderr ? 1 : 0, err: stderr };
    },
  };
  return runner;
}

test("argv resumes a thread when there is one, and starts one otherwise", () => {
  const fresh = buildArgv({ stable, prompt: "p", cwd: "/tmp" });
  expect(fresh.slice(0, 2)).toEqual(["exec", "--json"]);
  const resumed = buildArgv({ stable, prompt: "p", cwd: "/tmp", resumeSessionId: "thread-7" });
  expect(resumed.slice(0, 4)).toEqual(["exec", "resume", "thread-7", "--json"]);
  expect(resumed).toContain("-m");
  expect(resumed[resumed.indexOf("-m") + 1]).toBe("gpt-5-codex");
});

test("the CLI does not sandbox itself, because the container already did", () => {
  // Two boundaries were one too many. codex's own confinement is what produced
  // silent refusals, a `sandbox_permissions` key that turned out to be a no-op,
  // and a network override that only worked as argv on macOS — all inside a
  // container that already stops everything they were aiming at.
  for (const argv of [
    buildArgv({ stable, prompt: "p", cwd: "/tmp" }),
    buildArgv({ stable, prompt: "p", cwd: "/tmp", resumeSessionId: "t1" }),
  ]) {
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv).not.toContain("-s");
    expect(argv.join(" ")).not.toContain("sandbox_mode");
  }
});

test("argv keeps the agent reachable and the boss's own setup out", () => {
  const argv = buildArgv({ stable, prompt: "p", cwd: "/tmp", images: ["/tmp/a.png"] });
  // config.toml is the boss's, not the agent's.
  expect(argv).toContain("--ignore-user-config");
  expect(argv).toContain("--ignore-rules");
  expect(argv[argv.indexOf("-i") + 1]).toBe("/tmp/a.png");
  // The key that used to be here does nothing in 0.147; passing it back would
  // read as a sandbox that is not there.
  expect(argv.some((a) => a.startsWith("sandbox_permissions"))).toBe(false);
});

test("effort travels as a config override", () => {
  const withEffort = buildStable({
    rolePrompt: "r",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    allowedTools: ["Bash(orch *)"],
    addDirs: [],
  });
  const argv = buildArgv({ stable: withEffort, prompt: "p", cwd: "/tmp" });
  expect(argv).toContain('model_reasoning_effort="xhigh"');
  // And it is in the hashed prefix, so raising it rotates the session instead of
  // resuming one that was reasoning at another setting.
  expect(withEffort.hash).not.toBe(stable.hash);
});

test("token_count is the one place a real quota percentage arrives", async () => {
  const _spawned = Bun.spawn;
  // Verbatim from ~/.codex/sessions: 299 minutes is the 5h window, 10079 the week.
  const quota = JSON.stringify({
    type: "token_count",
    info: null,
    rate_limits: {
      primary: { used_percent: 34.5, window_minutes: 299, resets_in_seconds: 17940 },
      secondary: { used_percent: 12.25, window_minutes: 10079, resets_in_seconds: 604740 },
    },
  });
  const runner = fakeRunner([...LINES, quota]);
  {
    const r = await runTurn({ stable, prompt: "x", cwd: "/tmp", runner });
    expect(r.rateLimit?.fiveHourPercent).toBe(34.5);
    expect(r.rateLimit?.weeklyPercent).toBe(12.25);
    // "allowed" matters: handleRateLimit must not read a routine usage ping as a
    // throttle and downgrade the agent's model.
    expect(r.rateLimit?.status).toBe("allowed");
  }
});

test("the log keeps the shape of a turn without its command output", () => {
  const long = "x".repeat(5000);
  const line = {
    type: "item.completed",
    item: { type: "command_execution", command: "bun test", aggregated_output: long },
  };
  const out = z
    .object({
      item: z.object({ command: z.string(), aggregated_output: z.string() }),
    })
    .parse(trimItem(line));
  expect(out.item.command).toBe("bun test");
  expect(out.item.aggregated_output.length).toBeLessThan(500);
  expect(out.item.aggregated_output).toContain("5000 chars omitted");
});

test("the non-JSON banner does not derail the parse", async () => {
  const runner = fakeRunner(LINES);
  {
    const r = await runTurn({ stable, prompt: "do S1", cwd: "/tmp", runner });
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("019ff72d-e984-7053");
    expect(r.text).toBe("moved the check");
  }
});

test("JSON-shaped events with invalid fields are ignored instead of corrupting a turn", async () => {
  const runner = fakeRunner([
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "turn.completed", usage: null }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: "12" } }),
  ]);
  const r = await runTurn({ stable, prompt: "x", cwd: "/tmp", runner });
  expect(r.ok).toBe(false);
  expect(r.terminalReason).toBe("no_result");
  expect(r.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 });
});

test("usage maps onto the same shape the claude adapter produces", async () => {
  const runner = fakeRunner(LINES);
  {
    const r = await runTurn({ stable, prompt: "x", cwd: "/tmp", runner });
    // `input` means "what the cache missed" on both adapters. codex reports the
    // whole prompt in `input_tokens` with the cached part inside it, so the
    // cached tokens come off. Passing 27330 straight through counted 6912 tokens
    // twice and the three consumers of this shape all read it as context the
    // agent had just paid for: the cache ratio, the slice budget, and the
    // session rotation ceiling.
    expect(r.usage).toEqual({ input: 27330 - 6912, output: 5, cacheRead: 6912, cacheCreate: 0, thinking: 2 });
    expect(r.usage.input + r.usage.cacheRead).toBe(27330);
    // codex reports tokens but not money; inventing a number here would be worse
    // than attributing cost from tokens upstream.
    expect(r.filesTouched).toEqual(["auth/mw.ts"]);
    expect(r.toolSummaries.map((t) => t.name)).toEqual(["command_execution", "file_change"]);
  }
});

test("turn.failed is a failure with the reason kept", async () => {
  const runner = fakeRunner([
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "turn.failed", error: { message: "model not supported for this account" } }),
  ]);
  {
    const r = await runTurn({ stable, prompt: "x", cwd: "/tmp", runner });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("not supported");
  }
});

test("a child that says nothing at all fails loudly", async () => {
  const runner = fakeRunner(["Reading prompt from stdin..."], "codex: command failed\n");
  {
    const r = await runTurn({ stable, prompt: "x", cwd: "/tmp", runner });
    expect(r.ok).toBe(false);
    expect(r.terminalReason).toBe("no_result");
    expect(r.text).toContain("command failed");
  }
});

test("an error item is a notice on the timeline, not a failed turn", async () => {
  const runner = fakeRunner([
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    // Verbatim from a real run: this became a denial and would have escalated to
    // the boss for nothing.
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "error",
        message: "Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill.",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "error", message: "refused: writing outside the sandbox is not permitted" },
    }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ]);
  {
    const r = await runTurn({ stable, prompt: "x", cwd: "/tmp", runner });
    // Both are notices now. codex used `error` items for refusals AND for
    // notices, and telling them apart needed a regex over prose — which read
    // "skill descriptions were shortened" as a permission denial and would have
    // escalated it to the boss. Inside a container there are no refusals left to
    // find, so the guess goes with them.
    expect(r.toolSummaries.filter((t) => t.name === "notice").length).toBe(2);
    expect(r.ok).toBe(true);
  }
});

test("an empty model means whatever the account allows", () => {
  // Naming a model is rejected outright on a ChatGPT-account login, and that is
  // not a reason to fail every turn.
  const blank = buildStable({
    rolePrompt: "x",
    model: "",
    allowedTools: ["Read"],
    addDirs: ["/tmp"],
  });
  expect(buildArgv({ stable: blank, prompt: "p", cwd: "/tmp" })).not.toContain("-m");
  expect(buildArgv({ stable, prompt: "p", cwd: "/tmp" })).toContain("-m");
});

test("a resumed thread is not re-sent the stable half", async () => {
  const runner = fakeRunner(LINES);
  {
    await runTurn({ stable, prompt: "do S2", cwd: "/tmp", resumeSessionId: "t1", runner });
    let sent = runner.wrote;
    // The thread already holds the role prompt and the contract; sending them
    // again pays for them twice and moves the prefix the provider could have
    // matched. The first turn of a session still carries them.
    expect(sent).toBe("do S2");
    expect(sent).not.toContain("You are the Engineer.");

    await runTurn({ stable, prompt: "do S1", cwd: "/tmp", runner });
    sent = runner.wrote;
    expect(sent).toContain("You are the Engineer.");
    expect(sent.endsWith("do S1")).toBe(true);
  }
});
