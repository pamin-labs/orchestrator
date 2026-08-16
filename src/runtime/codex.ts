import { clip } from "../mech/util/text.ts";
import type { TurnHandlers, TurnResult, TurnSpec, ToolSummary, Usage } from "./claude.ts";
import { promptPath, summarizeTool } from "./claude.ts";
import { shq } from "../mech/util/shq.ts";

/**
 * `codex exec --json` behind the same interface as the claude adapter.
 *
 * Same shape on purpose: a role is configuration, so which CLI runs a turn should
 * be a config choice too, not a fork in the orchestrator. Event names differ, and
 * they were read off a real run rather than guessed:
 *
 *   thread.started   { thread_id }              <- the id `codex exec resume` wants
 *   turn.started
 *   item.completed   { item: { type, ... } }    <- agent_message | command_execution | error | …
 *   turn.completed   { usage: { input_tokens, cached_input_tokens, output_tokens, … } }
 *   turn.failed      { error: { message } }
 *
 * It also prints a non-JSON banner ("Reading prompt from stdin…"), so the parser
 * has to tolerate junk lines rather than assume clean JSONL.
 */

export function buildArgv(spec: Omit<TurnSpec, "runner">): string[] {
  const argv = spec.resumeSessionId
    ? ["exec", "resume", spec.resumeSessionId, "--json"]
    : ["exec", "--json"];
  argv.push("--skip-git-repo-check");
  // An empty model means "whatever the account allows": naming one is rejected
  // outright on a ChatGPT-account login, and that is not a reason to fail a turn.
  if (spec.stable.model.trim()) argv.push("-m", spec.stable.model);
  if (spec.stable.effort) argv.push("-c", `model_reasoning_effort="${spec.stable.effort}"`);
  // The boss's own setup is not this agent's. Same reason as the claude adapter's
  // `--setting-sources project,local`: inheriting a personal config.toml means the
  // role's model and effort are silently overridden, and the skill catalogue is
  // prefix tax on every turn.
  argv.push("--ignore-user-config", "--ignore-rules");
  // Web search, by the same rule as the claude side: `allowedTools` is a Claude
  // Code concept, but it is the one place that records which roles may look
  // things up, and two lists would drift.
  //
  // Measured on codex-cli 0.147, all four combinations run live:
  //   - search is ON by default, so granting it needs no flag
  //   - the documented `tools.web_search=true|false` key is ignored entirely —
  //     `false` still searched, which is the failure worth knowing about
  //   - `web_search="disabled"` works, and `web_search="live"` works
  // So this is written as a denial, not a grant. Everything else in the sandbox
  // is deny-only for the same reason: the default has to be the safe one.
  argv.push("-c", spec.stable.allowedTools.includes("WebSearch") ? 'web_search="live"' : 'web_search="disabled"');
  // No sandbox flags. The container is the boundary; asking the CLI to confine
  // itself inside one is the arrangement that produced silent refusals, a
  // no-op `sandbox_permissions` key and a macOS-only network override.
  argv.push("--dangerously-bypass-approvals-and-sandbox");
  for (const img of spec.images ?? []) argv.push("-i", img);
  return argv;
}

/**
 * What goes on disk, minus the command output.
 *
 * Same finding as the claude adapter's trimForLog, one CLI over: a turn's NDJSON
 * is mostly command output, and every measurement worth having from these files is
 * about shape — how many rounds, which tools, how many tokens, what failed. This
 * adapter was writing the raw line, so it kept all of it. Claude's version cannot
 * be reused: it trims `tool_use_result` and `message.content`, neither of which
 * codex emits. Everything long lands under `item`, so that is what gets clipped.
 */
const LOG_ITEM_CHARS = 400;

export function trimItem(l: Record<string, unknown>): Record<string, unknown> {
  const item = l.item;
  if (!item || typeof item !== "object") return l;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
    out[k] =
      typeof v === "string" && v.length > LOG_ITEM_CHARS
        ? `${v.slice(0, LOG_ITEM_CHARS)}… [${v.length} chars omitted]`
        : v;
  }
  return { ...l, item: out };
}

type Window = { used_percent?: number; window_minutes?: number; resets_in_seconds?: number };

type Line = {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string; message?: string; command?: string; path?: string };
  usage?: Record<string, number>;
  error?: { message?: string };
  message?: string;
  /** token_count carries the account's own quota state, both windows, as percentages. */
  rate_limits?: { primary?: Window; secondary?: Window };
  info?: { model_context_window?: number } | null;
};

/**
 * What one codex turn cost, in the shape the rest of the system bills in.
 *
 * `input_tokens` here is the whole prompt, cached part included — the opposite
 * of claude, whose `input_tokens` counts only what the cache missed. Reporting
 * codex's total under the same name made one number wrong in three places:
 * `cacheRatio` read 0.39 where the real hit rate was 0.92, `total`
 * double-counted every cached token so a codex slice hit its budget at half its
 * real spend, and the rotation ceiling (`input + cacheCreate` against 0.6 of a
 * 272k window) was cleared by a single 438k turn — so every codex agent started
 * a new session every turn and re-read the repo to find out where it was.
 * Measured: 438k input vs 402k cacheRead per job, 15 of 18 live codex agents
 * sitting above the ceiling.
 *
 * Exported because that subtraction is the difference between the two runtimes
 * and it was written down once. `pageindex.ts` had a second copy that took the
 * two shapes as a pair of key names — which is exactly the part that is *not*
 * shared — and so billed the indexer, the most frequent model call in the
 * system, for its cached tokens twice.
 */
export function codexUsage(u: Record<string, number> | undefined = {}): Usage {
  return {
    input: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
    output: u.output_tokens ?? 0,
    cacheRead: u.cached_input_tokens ?? 0,
    cacheCreate: u.cache_write_input_tokens ?? 0,
    thinking: u.reasoning_output_tokens ?? 0,
  };
}

export async function runTurn(spec: TurnSpec, h: TurnHandlers = {}): Promise<TurnResult> {
  // codex has no --append-system-prompt, so the stable half leads the first
  // message of a thread. It must NOT lead the rest: `codex exec resume` replays
  // the thread server-side, so re-sending the role prompt, the contract, the
  // onboarding pack and the lessons every turn both pays for them again and moves
  // the boundary of what the provider can match as an unchanged prefix — the
  // opposite of what resuming is for. A changed stable half rotates the session
  // (needsRotation compares the hash), which is where the new one gets sent.
  const input = spec.resumeSessionId
    ? spec.prompt
    : `${spec.stable.systemAppend}\n\n---\n\n${spec.prompt}`;

  // No stdin on the exec API, so the prompt travels as a file in the sandbox.
  // One file per call — a project sandbox is shared by every standing role.
  const promptFile = promptPath();
  await spec.runner.put(promptFile, input);
  const cmd = `codex ${buildArgv(spec).map(shq).join(" ")} < ${promptFile}; rc=$?; rm -f ${promptFile}; exit $rc`;

  const ac = new AbortController();
  spec.signal?.addEventListener("abort", () => ac.abort(), { once: true });
  h.onAbort?.(() => ac.abort());

  const log = spec.logPath ? Bun.file(spec.logPath).writer() : undefined;

  const result: TurnResult = {
    sessionId: spec.resumeSessionId ?? "",
    ok: false,
    terminalReason: "",
    text: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 },
    numTurns: 0,
    toolSummaries: [],
    filesTouched: [],
    logPath: spec.logPath,
  };
  const files = new Set<string>();

  const stream = spec.runner.lines(cmd, {
    cwd: spec.cwd,
    timeoutMs: spec.timeoutMs,
    env: spec.env,
    signal: ac.signal,
  });
  let tail = { code: -1, err: "" };
  try {
    while (true) {
      const step = await stream.next();
      if (step.done) {
        tail = step.value;
        break;
      }
      const raw = step.value;
      if (!raw.startsWith("{")) continue; // banners and friends
      let l: Line;
      try {
        l = JSON.parse(raw) as Line;
      } catch {
        continue;
      }
      log?.write(JSON.stringify(trimItem(l)) + "\n");

      switch (l.type) {
        case "thread.started":
          if (l.thread_id) result.sessionId = l.thread_id;
          break;
        case "turn.started":
          result.numTurns++;
          break;
        case "item.completed": {
          const it = l.item ?? {};
          if (it.type === "agent_message" && it.text) {
            result.text = it.text;
            h.onText?.(it.text);
          } else if (it.type === "error") {
            result.toolSummaries.push({ name: "notice", detail: clip(it.message ?? "", 120, true) });
          } else if (it.type) {
            const t: ToolSummary = summarizeTool(it.type, {
              command: it.command,
              file_path: it.path,
            });
            result.toolSummaries.push(t);
            h.onTool?.(t);
            if (it.path) files.add(it.path);
          }
          break;
        }
        case "turn.completed": {
          result.usage = codexUsage(l.usage);
          result.ok = true;
          result.terminalReason = "completed";
          break;
        }
        case "token_count": {
          // The only place either CLI hands over a real quota percentage. primary
          // is the 5-hour window (299 minutes), secondary the weekly one (10079).
          // The same event carries the model's real context window, which is the
          // denominator session rotation needs — 272000 for the gpt-5.6 family.
          if (l.info?.model_context_window) result.contextWindow = l.info.model_context_window;
          const { primary, secondary } = l.rate_limits ?? {};
          if (primary || secondary) {
            const now = Math.floor(Date.now() / 1000);
            result.rateLimit = {
              status: "allowed",
              rateLimitType: "five_hour",
              resetsAt: now + (primary?.resets_in_seconds ?? 0),
              fiveHourPercent: primary?.used_percent,
              weeklyPercent: secondary?.used_percent,
              weeklyResetsAt: secondary ? now + (secondary.resets_in_seconds ?? 0) : undefined,
            };
          }
          break;
        }
        case "turn.failed":
        case "error":
          result.ok = false;
          result.terminalReason = "error";
          result.text = l.error?.message ?? l.message ?? result.text;
          break;
      }
    }
  } finally {
    await log?.end();
  }

  result.filesTouched = [...files];
  if (!result.terminalReason) {
    result.terminalReason = "no_result";
    result.text ||= tail.err.trim().split("\n").slice(-5).join("\n");
  }
  return result;
}
