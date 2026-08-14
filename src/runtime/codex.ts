import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TurnHandlers, TurnResult, TurnSpec, ToolSummary } from "./claude.ts";
import { ndjsonLines, summarizeTool } from "./claude.ts";

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

export function buildArgv(spec: TurnSpec): string[] {
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
  // prefix tax on every turn. (CODEX_HOME does the rest — see codexHome().)
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
  // Sandbox. Measured on codex 0.147 (docs/decisions/006):
  //   - the default and `-s read-only` have no network AT ALL, not even loopback,
  //     and `orch` is HTTP to 127.0.0.1 — a read-only agent is a mute agent
  //   - the old `-c sandbox_permissions=[]` here was a no-op; 0.147 does not know
  //     that key, and passing "network-full-access" changed nothing either
  //   - config.toml's network_access is ignored by the macOS seatbelt (codex#10390),
  //     so this has to travel as argv
  // ponytail: the shape we actually want is the beta permission profiles
  // (base="read-only" + network.allow_local_binding + a domain allowlist). They
  // SIGABRT on 0.147. Until they land, the ceiling is "a codex role can reach the
  // public internet", which is also how it does web research.
  // `-s` only exists on `codex exec`. `codex exec resume` takes the same setting
  // as a config key and rejects the flag outright — so the first turn of every
  // codex agent ran and every turn after it died with `turn failed (no_result)`
  // and "tip: to pass -s as a value, use -- -s". Found by the Architect on a live
  // run, which is the only place it could be found: the flag is valid argv, the
  // model is fine, and the failure looks like an idle agent rather than an error.
  if (spec.resumeSessionId) argv.push("-c", 'sandbox_mode="workspace-write"');
  else argv.push("-s", "workspace-write");
  argv.push("-c", "sandbox_workspace_write.network_access=true");
  for (const img of spec.images ?? []) argv.push("-i", img);
  return argv;
}

/**
 * A CODEX_HOME holding nothing but the login.
 *
 * `--ignore-user-config` only drops config.toml. Skills still load from
 * $CODEX_HOME/skills — a live run announced "Skill descriptions were shortened to
 * fit the skills context budget", which is the same prefix tax that measured 46k
 * tokens a turn on the claude side. Pointing CODEX_HOME at a directory containing
 * one symlink removes them, and the symlink is what keeps the login shared: both
 * this and the boss's own codex refresh the same auth.json, so the OAuth refresh
 * token rotates in one place.
 *
 * ponytail: if codex ever replaces auth.json by atomic rename the symlink becomes
 * a private copy and the two logins drift. It shows up as an auth failure, and the
 * fix is to re-link after each turn.
 */
export function codexHome(dataDir: string, home = homedir()): string {
  const dir = join(dataDir, "codex-home");
  mkdirSync(dir, { recursive: true });
  const link = join(dir, "auth.json");
  if (!existsSync(link)) {
    try {
      symlinkSync(join(home, ".codex/auth.json"), link);
    } catch {
      // No login to borrow yet. codex will say so far more clearly than we can.
    }
  }
  return dir;
}

/** Refusal-shaped, as opposed to informational. */
const REFUSAL =
  /\b(not permitted|permission|denied|refus|forbidden|blocked|sandbox|not allowed|unauthorized|policy)\b/i;

const clip = (s: string, n = 120) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

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

  const proc = Bun.spawn(["codex", ...buildArgv(spec)], {
    cwd: spec.cwd,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(spec.codexHome ? { CODEX_HOME: spec.codexHome } : {}), ...spec.env },
    signal: spec.signal,
  });
  h.onPid?.(proc.pid);

  const timer = spec.timeoutMs ? setTimeout(() => proc.kill("SIGTERM"), spec.timeoutMs) : undefined;
  const log = spec.logPath ? Bun.file(spec.logPath).writer() : undefined;

  const result: TurnResult = {
    sessionId: spec.resumeSessionId ?? "",
    ok: false,
    terminalReason: "",
    text: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 },
    numTurns: 0,
    permissionDenials: [],
    toolSummaries: [],
    filesTouched: [],
    logPath: spec.logPath,
  };
  const files = new Set<string>();

  try {
    for await (const raw of ndjsonLines(proc.stdout)) {
      if (!raw.startsWith("{")) continue; // the stdin banner and friends
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
            // codex uses `error` items for refusals AND for notices. Live, a
            // "skill descriptions were shortened" notice became a permission
            // denial and would have escalated to the boss for nothing, so only
            // refusal-shaped messages count.
            const msg = it.message ?? "";
            if (REFUSAL.test(msg)) result.permissionDenials.push({ tool: "codex", message: msg });
            else result.toolSummaries.push({ name: "notice", detail: clip(msg) });
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
          const u = l.usage ?? {};
          result.usage = {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheRead: u.cached_input_tokens ?? 0,
            cacheCreate: u.cache_write_input_tokens ?? 0,
            thinking: u.reasoning_output_tokens ?? 0,
          };
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
    await proc.exited;
  } finally {
    if (timer) clearTimeout(timer);
    await log?.end();
  }

  result.filesTouched = [...files];
  if (!result.terminalReason) {
    const stderr = await new Response(proc.stderr).text();
    result.terminalReason = "no_result";
    result.text ||= stderr.trim().split("\n").slice(-5).join("\n");
  }
  return result;
}
