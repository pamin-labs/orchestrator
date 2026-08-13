import { expect, test } from "bun:test";
import { buildStable } from "../src/prompt/assemble.ts";
import { buildArgv, runTurn, trimItem } from "../src/runtime/codex.ts";

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

test("argv keeps the agent reachable and the boss's own setup out", () => {
  const argv = buildArgv({ stable, prompt: "p", cwd: "/tmp", images: ["/tmp/a.png"] });
  // Measured on codex 0.147: read-only has no network at all, not even loopback,
  // and `orch` is HTTP to 127.0.0.1 — read-only would make every codex agent mute.
  expect(argv[argv.indexOf("-s") + 1]).toBe("workspace-write");
  expect(argv).toContain("sandbox_workspace_write.network_access=true");
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
    settingsPath: "unused",
    addDirs: [],
  });
  const argv = buildArgv({ stable: withEffort, prompt: "p", cwd: "/tmp" });
  expect(argv).toContain('model_reasoning_effort="xhigh"');
  // And it is in the hashed prefix, so raising it rotates the session instead of
  // resuming one that was reasoning at another setting.
  expect(withEffort.hash).not.toBe(stable.hash);
});

test("token_count is the one place a real quota percentage arrives", async () => {
  const spawned = Bun.spawn;
  // Verbatim from ~/.codex/sessions: 299 minutes is the 5h window, 10079 the week.
  const quota = JSON.stringify({
    type: "token_count",
    info: null,
    rate_limits: {
      primary: { used_percent: 34.5, window_minutes: 299, resets_in_seconds: 17940 },
      secondary: { used_percent: 12.25, window_minutes: 10079, resets_in_seconds: 604740 },
    },
  });
  // @ts-expect-error swap in a fake child
  Bun.spawn = fakeSpawn([...LINES, quota]);
  try {
    const r = await runTurn({ stable, prompt: "x", cwd: "/tmp" });
    expect(r.rateLimit?.fiveHourPercent).toBe(34.5);
    expect(r.rateLimit?.weeklyPercent).toBe(12.25);
    // "allowed" matters: handleRateLimit must not read a routine usage ping as a
    // throttle and downgrade the agent's model.
    expect(r.rateLimit?.status).toBe("allowed");
  } finally {
    Bun.spawn = spawned;
  }
});

test("the log keeps the shape of a turn without its command output", () => {
  const long = "x".repeat(5000);
  const line = { type: "item.completed", item: { type: "command_execution", command: "bun test", aggregated_output: long } };
  const out = trimItem(line as Record<string, unknown>) as typeof line;
  expect(out.item.command).toBe("bun test");
  expect(out.item.aggregated_output.length).toBeLessThan(500);
  expect(out.item.aggregated_output).toContain("5000 chars omitted");
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

test("an informational error item is a notice, not a permission denial", async () => {
  const spawned = Bun.spawn;
  // @ts-expect-error fake child
  Bun.spawn = fakeSpawn([
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    // Verbatim from a real run: this became a denial and would have escalated to
    // the boss for nothing.
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "error",
        message:
          "Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill.",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "error", message: "refused: writing outside the sandbox is not permitted" },
    }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ]);
  try {
    const r = await runTurn({ stable, prompt: "x", cwd: "/tmp" });
    expect(r.permissionDenials.length).toBe(1);
    expect(JSON.stringify(r.permissionDenials[0])).toContain("not permitted");
    expect(r.toolSummaries.some((t) => t.name === "notice")).toBe(true);
  } finally {
    Bun.spawn = spawned;
  }
});

test("an empty model means whatever the account allows", () => {
  // Naming a model is rejected outright on a ChatGPT-account login, and that is
  // not a reason to fail every turn.
  const blank = buildStable({
    rolePrompt: "x",
    model: "",
    allowedTools: ["Read"],
    settingsPath: "u",
    addDirs: ["/tmp"],
  });
  expect(buildArgv({ stable: blank, prompt: "p", cwd: "/tmp" })).not.toContain("-m");
  expect(buildArgv({ stable, prompt: "p", cwd: "/tmp" })).toContain("-m");
});
