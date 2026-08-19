import { expect, test } from "bun:test";
import { modelAsk, type AskUsage } from "../../src/mech/knowledge/pageindex.ts";
import { testContext } from "../support/test-context.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";

/**
 * The one-shot model call the index is built and queried with.
 *
 * It is the most frequent model call in the system, it runs inside a container,
 * and it has failed silently twice: once by exiting 0 with the body
 * "Error: Reached max turns (1)" as every summary in the tree, and once by
 * spending money nothing counted because plain-text output reports no usage. So
 * what is asserted here is the command that goes in and what comes back out of
 * each CLI's own reporting format.
 */

const SCOPE = { project: 1 };

async function asked(handle: (cmd: string) => { code?: number; out?: string }) {
  const sandbox = fakeSandbox((cmd) => handle(cmd));
  return { ctx: await testContext({ sandbox }), sandbox };
}

const CLAUDE_OK = JSON.stringify({
  result: "src/mech/notify.ts",
  usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 900, cache_creation_input_tokens: 5 },
});

test("the prompt goes in on stdin through a file that is removed whatever the exit code", async () => {
  // The exec API has no stdin. A prompt left behind in /tmp of a long-lived
  // container is one file per query, forever, and it holds the boss's question.
  const { ctx, sandbox } = await asked(() => ({ out: CLAUDE_OK }));

  await modelAsk(ctx, { model: "haiku" }, SCOPE)("where does notify live?");

  const cmd = sandbox.commands[0]!;
  const file = /< (\S+);/.exec(cmd)![1]!;
  expect(sandbox.files.get(file)).toBe("where does notify live?");
  // `rc=$?` before the removal, so the CLI's exit code is what the caller sees
  // and not `rm`'s.
  expect(cmd).toContain(`rc=$?; rm -f ${file}; exit $rc`);
});

test("claude is asked for JSON so the call reports what it spent", async () => {
  const { ctx, sandbox } = await asked(() => ({ out: CLAUDE_OK }));
  const spent: AskUsage[] = [];

  const text = await modelAsk(ctx, { model: "haiku" }, SCOPE, 60_000, (u) => spent.push(u))("q");

  expect(text).toBe("src/mech/notify.ts");
  // Quoted token by token: the model name reaches the shell inert.
  expect(sandbox.commands[0]).toContain("'claude' '-p' '--output-format' 'json' '--model' 'haiku'");
  // No `--max-turns 1`: measured, it makes `claude -p` exit 0 with the body
  // "Error: Reached max turns (1)" and every summary in the index became that.
  expect(sandbox.commands[0]).not.toContain("--max-turns");
  expect(spent).toEqual([{ input: 11, output: 3, cacheRead: 900, cacheCreate: 5, thinking: 0 }]);
});

test("codex is run read-only and its answer is picked out of the stream", async () => {
  const stream = [
    "not json, a banner",
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "src/mech/notify.ts" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 4 } }),
  ].join("\n");
  const { ctx, sandbox } = await asked(() => ({ out: stream }));
  const spent: AskUsage[] = [];

  const text = await modelAsk(ctx, { runtime: "codex", model: "gpt-5" }, SCOPE, 60_000, (u) => spent.push(u))("q");

  expect(text).toBe("src/mech/notify.ts");
  expect(sandbox.commands[0]).toContain(
    "'codex' 'exec' '--json' '--skip-git-repo-check' '-s' 'read-only' '-m' 'gpt-5'",
  );
  expect(spent.length).toBe(1);
});

test("a CLI that fails degrades to the empty answer rather than taking retrieval down", async () => {
  // Both LLM steps fall back to the lexical map. An exception here would take
  // out `orch ctx query` for every agent, on a step that is an optimisation.
  const { ctx } = await asked(() => ({ code: 1, out: "boom" }));
  const spent: AskUsage[] = [];

  expect(await modelAsk(ctx, { model: "haiku" }, SCOPE, 60_000, (u) => spent.push(u))("q")).toBe("");
  // And nothing is charged for a call that produced nothing.
  expect(spent).toEqual([]);
});

test("a container that cannot be reached is an empty answer, not a throw", async () => {
  const ctx = await testContext({
    sandbox: {
      ...fakeSandbox(),
      exec: async () => {
        throw new Error("container unavailable");
      },
    },
  });

  expect(await modelAsk(ctx, { model: "haiku" }, SCOPE)("q")).toBe("");
});

test("claude's own error, reported on stdout with exit 0, is not treated as an answer", async () => {
  // The exit code is not the check and neither is the parse: the CLI prints some
  // of its failures as plain text and exits 0.
  const { ctx } = await asked(() => ({ out: "Error: credit balance is too low" }));

  expect(await modelAsk(ctx, { model: "haiku" }, SCOPE)("q")).toBe("");
});
