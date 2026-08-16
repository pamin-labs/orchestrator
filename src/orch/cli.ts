#!/usr/bin/env bun
/**
 * `orch` — what an agent uses to talk to the orchestrator, over Bash.
 *
 * Chosen over MCP and over sentinel JSON in the output: zero new tool schemas
 * (Bash already exists), real blocking calls with real return values on stdout,
 * identical shape for codex, and it can be exercised by hand from a terminal.
 *
 * Transport is the mailbox when `ORCH_MAILBOX` is set, which it always is inside
 * a sandbox — see viaMailbox below and docs/decisions/005. The HTTP path is what
 * a human gets running this by hand against a local orchestrator.
 *
 * The token arrives in the environment, injected by whoever spawned the turn. It
 * is the identity: anything else with a mailbox could otherwise claim to be any
 * agent.
 */

import { jsonOr } from "../mech/util/text.ts";
const URL_BASE = process.env.ORCH_URL ?? "http://127.0.0.1:47821";
const TOKEN = process.env.ORCH_TOKEN ?? "";

interface Parsed {
  flags: Record<string, string | string[] | true>;
  args: string[];
  /** Everything after a bare `--`, passed through untouched. */
  rest: string[];
}

export function parseArgs(argv: string[]): Parsed {
  const flags: Record<string, string | string[] | true> = {};
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
    // `-h` is not a positional argument. Without this, `orch ask-boss -h` filed
    // an escalation whose entire text was "-h" and waited for the boss to answer it.
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        // Repeated flags accumulate (--file a --file b) as an array, not as a
        // newline-joined string. Joining meant a single value that legitimately
        // contained a newline came back out as two — reachable with one line,
        // `orch pr --body "$(cat msg.txt)"`, and silent when it happened.
        const prev = flags[key];
        flags[key] = prev === undefined || prev === true ? next : [...(Array.isArray(prev) ? prev : [prev]), next];
        i++;
      }
      continue;
    }
    args.push(a);
  }
  return { flags, args, rest };
}

const list = (v: string | string[] | true | undefined): string[] =>
  Array.isArray(v) ? v : typeof v === "string" ? [v] : [];

/** `--arg k=v --arg j=w` -> `{k: "v", j: "w"}` */
export function kvArgs(v: string | string[] | true | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of list(v)) {
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * The mailbox: a request is a file, and so is its answer.
 *
 * An agent runs inside a sandbox now, and the only portable way out is the one
 * OpenSandbox already gives the host — the files API. `host.docker.internal`
 * works on Docker Desktop and does not exist on Linux, so building on it would
 * make the orchestrator macOS-and-Windows-only.
 *
 * Latency is the host's poll interval plus a couple of file operations, which
 * were measured at 1-5ms (docs/decisions/005). A lease that blocks for an hour
 * blocks here exactly as it did over HTTP.
 */
const MAILBOX = process.env.ORCH_MAILBOX ?? "";

async function viaMailbox(
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; text: string }> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const res = `${MAILBOX}/res/${id}.json`;
  await Bun.write(
    `${MAILBOX}/req/${id}.json`,
    JSON.stringify({ id, method, path, token: TOKEN, body: payload }),
  );
  // Poll the local filesystem, which costs nothing — the host is the one doing
  // real work between these checks.
  for (;;) {
    const f = Bun.file(res);
    if (await f.exists()) {
      const answer = JSON.parse(await f.text()) as { status: number; text: string };
      await f.delete().catch(() => {});
      return answer;
    }
    await Bun.sleep(120);
  }
}

async function call(
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
): Promise<{ status: number; text: string }> {
  if (MAILBOX) return viaMailbox(method, path, payload);
  const headers: Record<string, string> = { "x-orch-token": TOKEN };
  if (payload !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`${URL_BASE}${path}`, {
      method,
      headers,
      // Only ever set for POST: every GET caller passes no payload, and a body
      // on a GET is silently dropped by some runtimes and rejected by others.
      ...(method === "POST" && payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: res.status, text: await res.text() };
  } catch (e: any) {
    // Reached only with no mailbox in the environment. Inside a container that is
    // the whole story: 127.0.0.1 is the container, the orchestrator is not there,
    // and `ORCH_MAILBOX` is set for a turn and for nothing else — so a gate, a
    // lease or an install script calling `orch` lands here. Bare "connection
    // refused" reads as "the server is down" rather than "this process was never
    // given a route".
    return {
      status: 502,
      text:
        `cannot reach the orchestrator at ${URL_BASE}: ${e?.message ?? e}\n` +
        `ORCH_MAILBOX is unset, so this is not running inside a turn — a gate, a lease and an ` +
        `install script have no route to the orchestrator by design.`,
    };
  }
}

async function stdin(): Promise<string> {
  return await Bun.stdin.text();
}

const USAGE = `orch <command>

  ctx query <question>
  setup --cmd "<install command>" | --none        # bootstrap only, first turn
  ask-boss [--severity blocker|advisory] [--kind env|spec|boundary|design|other]
           [--brief "<=20 chars, what it is about>"] <question>
  lease <resource> [--arg k=v ...]
  lease log <id> [--grep TEXT]
  mail <target> --intent ask|request|inform|note|decision [--severity S] [--in-reply-to N] <body>
  journal add --kind decision|journal|retro|risk|fact [--file P ...] [--slice N]   # body on stdin
  task list | claim <id>
  task done <id> --claim JSON            # or pipe the claim on stdin
  task done <id> --already-done "<why>"  # an earlier slice already covered it
  review <slice_id> --verdict pass|fail [--note "…"]     # QA only
  audit <group_id> --verdict pass|fail [--note "…"]      # Auditor only
  pr <group_id> --title "<type(scope): subject>" -       # Scribe only; body on stdin
  answer <esc_id> --answer "…" [--ref <note_id>] | --abstain [--why "…"]
  triage <group_id> --as patch|respec|reject --note "…"  # CoS only
  draft <group_id>                                       # card on stdin, Dispatcher/PM
  owns <group_id> --path <glob> [--path <glob> ...]      # Architect cuts a boundary
  blocked <group_id> --path <file> --why "…"   # a defect outside your boundary
  drop <group_id> --why "…" --duplicate <group> | --commit <sha>
                                         # already covered; the boss confirms
  status <one line>
`;

export async function main(argv: string[]): Promise<number> {
  const { flags, args } = parseArgs(argv);
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
    case "setup": {
      // The bootstrap role's one verb: what installs this project's dependencies.
      if (flags.none) r = await call("POST", "/orch/setup", { none: true });
      else if (typeof flags.cmd === "string") r = await call("POST", "/orch/setup", { cmd: flags.cmd });
      else return usageError('setup needs --cmd "<command>" or --none');
      break;
    }
    case "ask-boss": {
      const question = args.slice(1).join(" ");
      if (!question) return usageError("ask-boss needs a question");
      // Blocks until answered — that is the point.
      r = await call("POST", "/orch/ask-boss", {
        severity: flags.severity ?? "advisory",
        question,
        brief: typeof flags.brief === "string" ? flags.brief : undefined,
        kind: typeof flags.kind === "string" ? flags.kind : undefined,
      });
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
        // No group id: the token says which group is asking, and a number in a
        // query string was a way to read another group's cards.
        r = await call("GET", "/orch/task");
      } else if (sub === "claim") {
        const id = Number(args[2]);
        if (!Number.isInteger(id)) {
          return usageError("task claim needs the numeric id from `orch task list`, not the title");
        }
        r = await call("POST", "/orch/task/claim", { task_id: id });
      } else if (sub === "split") {
        // One box, several unrelated asks. Titles+ideas on stdin as JSON, because a
        // paragraph per requirement does not fit in flags.
        const gid = Number(args[2]);
        if (!Number.isInteger(gid)) {
          return usageError(
            "orch task split <group_id> — then a JSON array on stdin: " +
              '[{"name":"short-name","idea":"one requirement, in the boss\'s words"}, …]',
          );
        }
        const raw = (await stdin()).trim();
        const parsed = raw ? jsonOr(raw, raw) : null;
        if (!Array.isArray(parsed)) {
          return usageError('split needs a JSON array on stdin: [{"name":"…","idea":"…"}, …]');
        }
        r = await call("POST", "/orch/split", { group_id: gid, requirements: parsed });
      } else if (sub === "done") {
        // Agents reach for a heredoc as naturally as for a flag, so accept the
        // claim on stdin too. The id stays required — silently completing "task
        // NaN" is how a claim ends up attached to nothing.
        const id = Number(args[2]);
        if (!Number.isInteger(id)) {
          return usageError(
            "task done needs the numeric id from `orch task list`, not the title: " +
              "orch task done <id> [--claim JSON]",
          );
        }
        const alreadyDone = typeof flags["already-done"] === "string" ? flags["already-done"] : "";
        const inline = typeof flags.claim === "string" ? flags.claim : "";
        const piped = inline || alreadyDone ? "" : await stdin();
        const raw = inline || piped;
        r = await call("POST", "/orch/task/done", {
          task_id: id,
          claim: raw.trim() ? jsonOr(raw.trim(), raw.trim()) : undefined,
          already_done: alreadyDone || undefined,
          review: typeof flags.review === "string" ? flags.review : undefined,
        });
      } else return usageError(`unknown task subcommand ${sub}`);
      break;
    }
    case "review": {
      // A verdict is a value, not prose: mis-reading a "fail" as a "pass" is the
      // one error the whole review pipeline exists to prevent.
      const id = Number(sub);
      if (!Number.isInteger(id)) return usageError("review needs a slice id");
      if (flags.verdict !== "pass" && flags.verdict !== "fail") {
        return usageError("review needs --verdict pass|fail");
      }
      const note = typeof flags.note === "string" ? flags.note : args.slice(2).join(" ");
      r = await call("POST", "/orch/review", { slice_id: id, verdict: flags.verdict, note });
      break;
    }
    case "audit": {
      if (!sub) return usageError("audit needs a group id or name");
      if (flags.verdict !== "pass" && flags.verdict !== "fail") {
        return usageError("audit needs --verdict pass|fail");
      }
      const note = typeof flags.note === "string" ? flags.note : args.slice(2).join(" ");
      r = await call("POST", "/orch/audit", { group_id: sub, verdict: flags.verdict, note });
      break;
    }
    case "pr": {
      if (!sub) return usageError("pr needs a group id");
      if (typeof flags.title !== "string" || !flags.title.trim()) {
        return usageError('pr needs --title "<type(scope): subject>"');
      }
      // Body on stdin, like `journal add`: it is paragraphs with blank lines in
      // them, and an argv the agent has to quote is an argv the agent gets wrong.
      r = await call("POST", "/orch/pr", { group_id: sub, title: flags.title, body: await stdin() });
      break;
    }
    case "answer": {
      const id = Number(sub);
      if (!Number.isInteger(id)) return usageError("answer needs an escalation id");
      if (flags.abstain) {
        r = await call("POST", "/orch/answer", {
          escalation_id: id,
          abstain: true,
          why: typeof flags.why === "string" ? flags.why : "",
        });
        break;
      }
      const a = typeof flags.answer === "string" ? flags.answer : args.slice(2).join(" ");
      if (!a) return usageError("answer needs --answer \"…\" or --abstain");
      r = await call("POST", "/orch/answer", {
        escalation_id: id,
        answer: a,
        ref: flags.ref ? Number(flags.ref) : undefined,
      });
      break;
    }
    case "triage": {
      if (!sub) return usageError("triage needs a group id or name");
      if (!["patch", "respec", "reject"].includes(String(flags.as))) {
        return usageError("triage needs --as patch|respec|reject");
      }
      r = await call("POST", "/orch/triage", {
        group_id: sub,
        as: flags.as,
        note: typeof flags.note === "string" ? flags.note : args.slice(2).join(" "),
      });
      break;
    }
    case "draft": {
      // id or name; the server resolves either. An agent reaches for the name it
      // can see, and refusing that teaches it nothing.
      r = await call("POST", "/orch/draft", {
        group_id: sub ?? process.env.ORCH_GRP_ID,
        card: await stdin(),
      });
      break;
    }
    case "owns": {
      const paths = list(flags.path);
      if (paths.length === 0) return usageError("owns needs at least one --path <glob>");
      r = await call("POST", "/orch/owns", { group_id: sub ?? process.env.ORCH_GRP_ID, paths });
      break;
    }
    case "blocked": {
      r = await call("POST", "/orch/blocked", {
        group_id: sub ?? process.env.ORCH_GRP_ID,
        path: typeof flags.path === "string" ? flags.path : "",
        why: typeof flags.why === "string" ? flags.why : "",
      });
      break;
    }
    case "drop": {
      r = await call("POST", "/orch/drop", {
        group_id: sub ?? process.env.ORCH_GRP_ID,
        why: typeof flags.why === "string" ? flags.why : "",
        commit: typeof flags.commit === "string" ? flags.commit : undefined,
        duplicate: typeof flags.duplicate === "string" ? flags.duplicate : undefined,
      });
      break;
    }
    case "status": {
      r = await call("POST", "/orch/status", { text: args.slice(1).join(" ") });
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

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
