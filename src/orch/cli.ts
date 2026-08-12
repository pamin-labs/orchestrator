#!/usr/bin/env bun
/**
 * `orch` — what an agent uses to talk to the orchestrator, over Bash.
 *
 * Chosen over MCP and over sentinel JSON in the output: zero new tool schemas
 * (Bash already exists), real blocking calls with real return values on stdout,
 * identical shape for codex, and it can be exercised by hand from a terminal.
 *
 * The socket path and the caller's identity arrive in the environment, injected
 * by whoever spawned the turn. A unix socket needs no other auth.
 */

const SOCKET = process.env.ORCH_SOCKET ?? "data/orch.sock";
const AGENT_ID = Number(process.env.ORCH_AGENT_ID ?? 0);

interface Parsed {
  flags: Record<string, string | true>;
  args: string[];
  /** Everything after a bare `--`, passed through untouched. */
  rest: string[];
}

export function parseArgs(argv: string[]): Parsed {
  const flags: Record<string, string | true> = {};
  const args: string[] = [];
  const rest: string[] = [];
  let afterDashDash = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (afterDashDash) {
      rest.push(a);
      continue;
    }
    if (a === "--") {
      afterDashDash = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        // Repeated flags accumulate as a newline-joined value (--file a --file b).
        const prev = flags[key];
        flags[key] = typeof prev === "string" ? `${prev}\n${next}` : next;
        i++;
      }
      continue;
    }
    args.push(a);
  }
  return { flags, args, rest };
}

const list = (v: string | true | undefined): string[] =>
  typeof v === "string" ? v.split("\n").filter(Boolean) : [];

/** `--arg k=v --arg j=w` -> `{k: "v", j: "w"}` */
export function kvArgs(v: string | true | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of list(v)) {
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

async function call(
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://orch${path}`, {
    method,
    unix: SOCKET,
    body: payload === undefined ? undefined : JSON.stringify({ agent_id: AGENT_ID, ...(payload as object) }),
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
  } as RequestInit);
  return { status: res.status, text: await res.text() };
}

async function stdin(): Promise<string> {
  return await Bun.stdin.text();
}

const USAGE = `orch <command>

  ctx query <question>
  ask-boss [--severity blocker|advisory] <question>
  lease <resource> [--arg k=v ...]
  lease log <id> [--grep RE]
  mail <target> --intent ask|request|inform|note|decision [--severity S] [--in-reply-to N] <body>
  journal add --kind decision|journal|retro|risk|fact [--file P ...] [--slice N]   # body on stdin
  task list | claim <id> | done <id> [--claim JSON]
  status <one line>
  git -- <args...>`;

export async function main(argv: string[]): Promise<number> {
  const { flags, args, rest } = parseArgs(argv);
  const [cmd, sub] = args;

  if (!cmd || flags.help) {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }

  let r: { status: number; text: string };
  switch (cmd) {
    case "ctx": {
      if (sub !== "query") return usageError(`unknown ctx subcommand ${sub}`);
      r = await call("POST", "/orch/ctx/query", { question: args.slice(2).join(" ") });
      break;
    }
    case "ask-boss": {
      const question = args.slice(1).join(" ");
      if (!question) return usageError("ask-boss needs a question");
      // Blocks until answered — that is the point.
      r = await call("POST", "/orch/ask-boss", { severity: flags.severity ?? "advisory", question });
      break;
    }
    case "lease": {
      if (sub === "log") {
        const id = args[2];
        const grep = typeof flags.grep === "string" ? `?grep=${encodeURIComponent(flags.grep)}` : "";
        r = await call("GET", `/orch/lease/${id}/log${grep}`);
        break;
      }
      if (!sub) return usageError("lease needs a resource name");
      r = await call("POST", "/orch/lease", { resource: sub, args: kvArgs(flags.arg) });
      break;
    }
    case "mail": {
      if (!sub) return usageError("mail needs a target");
      r = await call("POST", "/orch/mail", {
        target: sub,
        intent: flags.intent ?? "inform",
        severity: flags.severity,
        in_reply_to: flags["in-reply-to"],
        body: args.slice(2).join(" "),
      });
      break;
    }
    case "journal": {
      if (sub !== "add") return usageError(`unknown journal subcommand ${sub}`);
      r = await call("POST", "/orch/journal", {
        kind: flags.kind ?? "journal",
        body: await stdin(),
        files: list(flags.file),
        slice_id: flags.slice ? Number(flags.slice) : undefined,
      });
      break;
    }
    case "task": {
      if (sub === "list" || sub === undefined) {
        r = await call("GET", `/orch/task?grp=${process.env.ORCH_GRP_ID ?? ""}`);
      } else if (sub === "claim") {
        r = await call("POST", "/orch/task/claim", { task_id: Number(args[2]) });
      } else if (sub === "done") {
        r = await call("POST", "/orch/task/done", {
          task_id: Number(args[2]),
          claim: typeof flags.claim === "string" ? safeJson(flags.claim) : undefined,
        });
      } else return usageError(`unknown task subcommand ${sub}`);
      break;
    }
    case "status": {
      r = await call("POST", "/orch/status", { text: args.slice(1).join(" ") });
      break;
    }
    case "git": {
      const argvGit = rest.length ? rest : args.slice(1);
      if (!argvGit.length) return usageError("git needs arguments");
      r = await call("POST", "/orch/git", { argv: argvGit });
      break;
    }
    default:
      return usageError(`unknown command ${cmd}`);
  }

  // Non-2xx goes to stderr with a non-zero exit so the agent sees a real
  // failure instead of mistaking a rejection message for a result.
  if (r.status >= 400) {
    console.error(r.text);
    return 1;
  }
  console.log(r.text);
  return 0;
}

function usageError(msg: string): number {
  console.error(`${msg}\n\n${USAGE}`);
  return 2;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
