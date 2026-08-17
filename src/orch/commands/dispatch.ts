import type { hc } from "hono/client";
import { ChangedFilesClaimSchema, MailIntent, SplitRequirements } from "../../contracts/orch.ts";
import { jsonOr } from "../../contracts/json.ts";
import type { ProtocolResponse } from "../../contracts/protocol.ts";
import type { OrchType } from "../../http/routes/orch.ts";
import { kvArgs, list, type Parsed, scalar } from "./args.ts";

export type OrchClient = ReturnType<typeof hc<OrchType>>;
type CommandResponse = ProtocolResponse | ExitResult;
type CommandHandler = (context: HandlerContext) => Promise<CommandResponse>;

interface HandlerContext {
  orch: OrchClient;
  flags: Parsed["flags"];
  args: string[];
  sub: string | undefined;
  send: (request: Promise<Response>) => Promise<ProtocolResponse>;
  readStdin: () => Promise<string>;
}

export interface DispatchContext {
  orch: OrchClient;
  parsed: Parsed;
  version: string;
  send: (request: Promise<Response>) => Promise<ProtocolResponse>;
  readStdin: () => Promise<string>;
}

export type DispatchResult =
  | { kind: "response"; response: ProtocolResponse }
  | { kind: "exit"; code: number; stdout?: string; stderr?: string };

type ExitResult = Extract<DispatchResult, { kind: "exit" }>;

const USAGE = `orch <command>

  --version
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

const usageError = (message: string): ExitResult => ({
  kind: "exit",
  code: 2,
  stderr: `${message}\n\n${USAGE}`,
});

const response = (value: ProtocolResponse): DispatchResult => ({ kind: "response", response: value });

async function handleCtx(context: HandlerContext): Promise<CommandResponse> {
  if (context.sub !== "query") return usageError(`unknown ctx subcommand ${context.sub}`);
  return context.send(context.orch.ctx.query.$post({ json: { question: context.args.slice(2).join(" ") } }));
}

async function handleSetup(context: HandlerContext): Promise<CommandResponse> {
  if (context.flags.none) return context.send(context.orch.setup.$post({ json: { none: true } }));
  const command = scalar(context.flags.cmd);
  return command
    ? context.send(context.orch.setup.$post({ json: { cmd: command } }))
    : usageError('setup needs --cmd "<command>" or --none');
}

async function handleAskBoss(context: HandlerContext): Promise<CommandResponse> {
  const question = context.args.slice(1).join(" ");
  if (!question) return usageError("ask-boss needs a question");
  return context.send(
    context.orch["ask-boss"].$post({
      json: {
        severity: scalar(context.flags.severity) ?? "advisory",
        question,
        brief: scalar(context.flags.brief),
        kind: scalar(context.flags.kind),
      },
    }),
  );
}

async function handleLease(context: HandlerContext): Promise<CommandResponse> {
  if (context.sub === "log") {
    const id = context.args[2];
    return id
      ? context.send(context.orch.lease[":id"].log.$get({ param: { id }, query: { grep: scalar(context.flags.grep) } }))
      : usageError("lease log needs an id");
  }
  return context.sub
    ? context.send(context.orch.lease.$post({ json: { resource: context.sub, args: kvArgs(context.flags.arg) } }))
    : usageError("lease needs a resource name");
}

async function handleMail(context: HandlerContext): Promise<CommandResponse> {
  if (!context.sub) return usageError("mail needs a target");
  const intent = MailIntent.safeParse(scalar(context.flags.intent) ?? "inform");
  if (!intent.success) return usageError("mail --intent must be ask|request|inform|note|decision");
  return context.send(
    context.orch.mail.$post({
      json: {
        target: context.sub,
        intent: intent.data,
        severity: scalar(context.flags.severity),
        in_reply_to: scalar(context.flags["in-reply-to"]),
        body: context.args.slice(2).join(" "),
      },
    }),
  );
}

async function handleJournal(context: HandlerContext): Promise<CommandResponse> {
  if (context.sub !== "add") return usageError(`unknown journal subcommand ${context.sub}`);
  return context.send(
    context.orch.journal.$post({
      json: {
        kind: scalar(context.flags.kind) ?? "journal",
        body: await context.readStdin(),
        files: list(context.flags.file),
        slice_id: scalar(context.flags.slice),
      },
    }),
  );
}

async function handleTaskList(context: HandlerContext): Promise<CommandResponse> {
  return context.send(context.orch.task.$get());
}

async function handleTaskClaim(context: HandlerContext): Promise<CommandResponse> {
  const id = Number(context.args[2]);
  return Number.isInteger(id)
    ? context.send(context.orch.task.claim.$post({ json: { task_id: id } }))
    : usageError("task claim needs the numeric id from `orch task list`, not the title");
}

async function handleTaskSplit(context: HandlerContext): Promise<CommandResponse> {
  const groupId = Number(context.args[2]);
  if (!Number.isInteger(groupId)) {
    return usageError(
      "orch task split <group_id> — then a JSON array on stdin: " +
        '[{"name":"short-name","idea":"one requirement, in the boss\'s words"}, …]',
    );
  }
  const raw = (await context.readStdin()).trim();
  const requirements = raw ? jsonOr(raw, SplitRequirements.nullable(), null) : null;
  return requirements
    ? context.send(context.orch.split.$post({ json: { group_id: groupId, requirements } }))
    : usageError('split needs a JSON array on stdin: [{"name":"…","idea":"…"}, …]');
}

function taskCompletionInput(context: HandlerContext, piped: string) {
  const alreadyDone = scalar(context.flags["already-done"]) ?? "";
  const inline = scalar(context.flags.claim) ?? "";
  const raw = inline || piped;
  return {
    alreadyDone,
    raw,
    claim: raw.trim() ? jsonOr(raw.trim(), ChangedFilesClaimSchema.nullable(), null) : undefined,
  };
}

async function handleTaskDone(context: HandlerContext): Promise<CommandResponse> {
  const id = Number(context.args[2]);
  if (!Number.isInteger(id)) {
    return usageError(
      "task done needs the numeric id from `orch task list`, not the title: orch task done <id> [--claim JSON]",
    );
  }
  const shouldRead = !scalar(context.flags.claim) && !scalar(context.flags["already-done"]);
  const { alreadyDone, raw, claim } = taskCompletionInput(context, shouldRead ? await context.readStdin() : "");
  if (raw.trim() && !claim) {
    return usageError('task done --claim must be JSON: {"files":["src/file.ts"],"summary":"what changed"}');
  }
  const review = scalar(context.flags.review);
  if (alreadyDone) {
    return context.send(context.orch.task.done.$post({ json: { task_id: id, already_done: alreadyDone, review } }));
  }
  return claim
    ? context.send(context.orch.task.done.$post({ json: { task_id: id, claim, review } }))
    : usageError("task done needs --claim JSON or --already-done <why>");
}

const TASK_HANDLERS: Record<string, CommandHandler> = {
  list: handleTaskList,
  claim: handleTaskClaim,
  split: handleTaskSplit,
  done: handleTaskDone,
};

async function handleTask(context: HandlerContext): Promise<CommandResponse> {
  const subcommand = context.sub ?? "list";
  const handler = TASK_HANDLERS[subcommand];
  return handler ? handler(context) : usageError(`unknown task subcommand ${context.sub}`);
}

async function handleVerdict(context: HandlerContext, kind: "review" | "audit"): Promise<CommandResponse> {
  if (!context.sub) return usageError(`${kind} needs a ${kind === "review" ? "slice id" : "group id or name"}`);
  if (context.flags.verdict !== "pass" && context.flags.verdict !== "fail") {
    return usageError(`${kind} needs --verdict pass|fail`);
  }
  const note = scalar(context.flags.note) ?? context.args.slice(2).join(" ");
  if (kind === "review") {
    const id = Number(context.sub);
    return Number.isInteger(id)
      ? context.send(context.orch.review.$post({ json: { slice_id: id, verdict: context.flags.verdict, note } }))
      : usageError("review needs a slice id");
  }
  return context.send(
    context.orch.audit.$post({ json: { group_id: context.sub, verdict: context.flags.verdict, note } }),
  );
}

const handleReview = (context: HandlerContext) => handleVerdict(context, "review");
const handleAudit = (context: HandlerContext) => handleVerdict(context, "audit");

async function handlePr(context: HandlerContext): Promise<CommandResponse> {
  if (!context.sub) return usageError("pr needs a group id");
  const title = scalar(context.flags.title);
  if (!title?.trim()) return usageError('pr needs --title "<type(scope): subject>"');
  return context.send(
    context.orch.pr.$post({ json: { group_id: context.sub, title, body: await context.readStdin() } }),
  );
}

async function handleAnswer(context: HandlerContext): Promise<CommandResponse> {
  const id = Number(context.sub);
  if (!Number.isInteger(id)) return usageError("answer needs an escalation id");
  if (context.flags.abstain) {
    return context.send(
      context.orch.answer.$post({
        json: { escalation_id: id, abstain: true, why: scalar(context.flags.why) ?? "" },
      }),
    );
  }
  const answer = scalar(context.flags.answer) ?? context.args.slice(2).join(" ");
  return answer
    ? context.send(context.orch.answer.$post({ json: { escalation_id: id, answer, ref: scalar(context.flags.ref) } }))
    : usageError('answer needs --answer "…" or --abstain');
}

async function handleTriage(context: HandlerContext): Promise<CommandResponse> {
  if (!context.sub) return usageError("triage needs a group id or name");
  const disposition = scalar(context.flags.as);
  if (disposition !== "patch" && disposition !== "respec" && disposition !== "reject") {
    return usageError("triage needs --as patch|respec|reject");
  }
  return context.send(
    context.orch.triage.$post({
      json: {
        group_id: context.sub,
        as: disposition,
        note: scalar(context.flags.note) ?? context.args.slice(2).join(" "),
      },
    }),
  );
}

async function handleDraft(context: HandlerContext): Promise<CommandResponse> {
  return context.send(
    context.orch.draft.$post({
      json: { group_id: context.sub ?? process.env.ORCH_GRP_ID, card: await context.readStdin() },
    }),
  );
}

async function handleOwns(context: HandlerContext): Promise<CommandResponse> {
  const paths = list(context.flags.path);
  return paths.length
    ? context.send(context.orch.owns.$post({ json: { group_id: context.sub ?? process.env.ORCH_GRP_ID, paths } }))
    : usageError("owns needs at least one --path <glob>");
}

async function handleBlocked(context: HandlerContext): Promise<CommandResponse> {
  return context.send(
    context.orch.blocked.$post({
      json: {
        group_id: context.sub ?? process.env.ORCH_GRP_ID,
        path: scalar(context.flags.path) ?? "",
        why: scalar(context.flags.why) ?? "",
      },
    }),
  );
}

async function handleDrop(context: HandlerContext): Promise<CommandResponse> {
  return context.send(
    context.orch.drop.$post({
      json: {
        group_id: context.sub ?? process.env.ORCH_GRP_ID,
        why: scalar(context.flags.why) ?? "",
        commit: scalar(context.flags.commit),
        duplicate: scalar(context.flags.duplicate),
      },
    }),
  );
}

async function handleStatus(context: HandlerContext): Promise<CommandResponse> {
  return context.send(context.orch.status.$post({ json: { text: context.args.slice(1).join(" ") } }));
}

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  ctx: handleCtx,
  setup: handleSetup,
  "ask-boss": handleAskBoss,
  lease: handleLease,
  mail: handleMail,
  journal: handleJournal,
  task: handleTask,
  review: handleReview,
  audit: handleAudit,
  pr: handlePr,
  answer: handleAnswer,
  triage: handleTriage,
  draft: handleDraft,
  owns: handleOwns,
  blocked: handleBlocked,
  drop: handleDrop,
  status: handleStatus,
};

export async function dispatchCommand(context: DispatchContext): Promise<DispatchResult> {
  const { flags, args } = context.parsed;
  const [command, sub] = args;
  if (flags.version === true && args.length === 0) {
    return { kind: "exit", code: 0, stdout: context.version };
  }
  if (!command || flags.help) {
    return { kind: "exit", code: command ? 0 : 2, stdout: USAGE };
  }
  const handler = COMMAND_HANDLERS[command];
  if (!handler) return usageError(`unknown command ${command}`);
  const result = await handler({
    orch: context.orch,
    flags,
    args,
    sub,
    send: context.send,
    readStdin: context.readStdin,
  });
  return "kind" in result ? result : response(result);
}
