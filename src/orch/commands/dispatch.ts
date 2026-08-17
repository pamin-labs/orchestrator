import { Command, CommanderError } from "commander";
import type { hc } from "hono/client";
import { ChangedFilesClaimSchema, MailIntent, SplitRequirements } from "../../contracts/orch.ts";
import { jsonOr } from "../../contracts/json.ts";
import type { ProtocolResponse } from "../../contracts/protocol.ts";
import type { OrchType } from "../../http/routes/orch.ts";

type CommandResponse = ProtocolResponse | ExitResult;

/** The argv to parse, and everything a handler is allowed to reach for. */
export interface DispatchContext {
  orch: ReturnType<typeof hc<OrchType>>;
  send: (request: Promise<Response>) => Promise<ProtocolResponse>;
  readStdin: () => Promise<string>;
  argv: string[];
  version: string;
}

export type DispatchResult =
  | { kind: "response"; response: ProtocolResponse }
  | { kind: "exit"; code: number; stdout?: string; stderr?: string };

type ExitResult = Extract<DispatchResult, { kind: "exit" }>;

/**
 * A refusal an agent can act on, and nothing else.
 *
 * Every message names the flag and shows the shape it wants. The whole command
 * list used to be appended to each one; it is `orch` and `orch <command> --help`
 * now, so the sentence that says what is wrong is not buried under 26 lines that
 * are the same on every failure.
 */
const usageError = (message: string): ExitResult => ({ kind: "exit", code: 2, stderr: message });

/** `--file a --file b` -> `["a", "b"]`, rather than the last one winning. */
const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** `--arg k=v --arg j=w` -> `{k: "v", j: "w"}` */
export function kvArgs(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of values) {
    const equals = pair.indexOf("=");
    if (equals > 0) out[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return out;
}

async function ctxQuery(api: DispatchContext, question: string[]): Promise<CommandResponse> {
  return api.send(api.orch.ctx.query.$post({ json: { question: question.join(" ") } }));
}

async function setup(api: DispatchContext, opts: { cmd?: string; none?: boolean }): Promise<CommandResponse> {
  if (opts.none) return api.send(api.orch.setup.$post({ json: { none: true } }));
  return opts.cmd
    ? api.send(api.orch.setup.$post({ json: { cmd: opts.cmd } }))
    : usageError('setup needs --cmd "<command>" or --none');
}

async function askBoss(
  api: DispatchContext,
  words: string[],
  opts: { severity?: string; kind?: string; brief?: string },
): Promise<CommandResponse> {
  const question = words.join(" ");
  if (!question) return usageError("ask-boss needs a question");
  return api.send(
    api.orch["ask-boss"].$post({
      json: { severity: opts.severity ?? "advisory", question, brief: opts.brief, kind: opts.kind },
    }),
  );
}

async function lease(
  api: DispatchContext,
  resource: string | undefined,
  opts: { arg: string[] },
): Promise<CommandResponse> {
  return resource
    ? api.send(api.orch.lease.$post({ json: { resource, args: kvArgs(opts.arg) } }))
    : usageError("lease needs a resource name");
}

async function leaseLog(api: DispatchContext, id: string, opts: { grep?: string }): Promise<CommandResponse> {
  return api.send(api.orch.lease[":id"].log.$get({ param: { id }, query: { grep: opts.grep } }));
}

async function mail(
  api: DispatchContext,
  target: string,
  body: string[],
  opts: { intent?: string; severity?: string; inReplyTo?: string },
): Promise<CommandResponse> {
  const intent = MailIntent.safeParse(opts.intent ?? "inform");
  if (!intent.success) return usageError("mail --intent must be ask|request|inform|note|decision");
  return api.send(
    api.orch.mail.$post({
      json: {
        target,
        intent: intent.data,
        severity: opts.severity,
        in_reply_to: opts.inReplyTo,
        body: body.join(" "),
      },
    }),
  );
}

async function journalAdd(
  api: DispatchContext,
  opts: { kind?: string; file: string[]; slice?: string },
): Promise<CommandResponse> {
  return api.send(
    api.orch.journal.$post({
      json: {
        kind: opts.kind ?? "journal",
        body: await api.readStdin(),
        files: opts.file,
        slice_id: opts.slice,
      },
    }),
  );
}

async function taskList(api: DispatchContext): Promise<CommandResponse> {
  return api.send(api.orch.task.$get());
}

async function taskClaim(api: DispatchContext, taskId: string): Promise<CommandResponse> {
  const id = Number(taskId);
  return Number.isInteger(id)
    ? api.send(api.orch.task.claim.$post({ json: { task_id: id } }))
    : usageError("task claim needs the numeric id from `orch task list`, not the title");
}

async function taskSplit(api: DispatchContext, groupId: string): Promise<CommandResponse> {
  const id = Number(groupId);
  if (!Number.isInteger(id)) {
    return usageError(
      "orch task split <group_id> — then a JSON array on stdin: " +
        '[{"name":"short-name","idea":"one requirement, in the boss\'s words"}, …]',
    );
  }
  const raw = (await api.readStdin()).trim();
  const requirements = raw ? jsonOr(raw, SplitRequirements.nullable(), null) : null;
  return requirements
    ? api.send(api.orch.split.$post({ json: { group_id: id, requirements } }))
    : usageError('split needs a JSON array on stdin: [{"name":"…","idea":"…"}, …]');
}

interface TaskDoneOptions {
  claim?: string;
  alreadyDone?: string;
  review?: string;
}

async function taskDone(
  api: DispatchContext,
  taskId: string,
  _dash: string | undefined,
  opts: TaskDoneOptions,
): Promise<CommandResponse> {
  const id = Number(taskId);
  if (!Number.isInteger(id)) {
    return usageError(
      "task done needs the numeric id from `orch task list`, not the title: orch task done <id> [--claim JSON]",
    );
  }
  const shouldRead = !opts.claim && !opts.alreadyDone;
  const alreadyDone = opts.alreadyDone ?? "";
  const raw = (opts.claim ?? "") || (shouldRead ? await api.readStdin() : "");
  const claim = raw.trim() ? jsonOr(raw.trim(), ChangedFilesClaimSchema.nullable(), null) : undefined;
  if (raw.trim() && !claim) {
    return usageError('task done --claim must be JSON: {"files":["src/file.ts"],"summary":"what changed"}');
  }
  const review = opts.review;
  if (alreadyDone) {
    return api.send(api.orch.task.done.$post({ json: { task_id: id, already_done: alreadyDone, review } }));
  }
  return claim
    ? api.send(api.orch.task.done.$post({ json: { task_id: id, claim, review } }))
    : usageError("task done needs --claim JSON or --already-done <why>");
}

async function verdict(
  api: DispatchContext,
  kind: "review" | "audit",
  id: string | undefined,
  words: string[],
  opts: { verdict?: string; note?: string },
): Promise<CommandResponse> {
  if (!id) return usageError(`${kind} needs a ${kind === "review" ? "slice id" : "group id or name"}`);
  if (opts.verdict !== "pass" && opts.verdict !== "fail") return usageError(`${kind} needs --verdict pass|fail`);
  const note = opts.note ?? words.join(" ");
  if (kind === "audit") {
    return api.send(api.orch.audit.$post({ json: { group_id: id, verdict: opts.verdict, note } }));
  }
  const sliceId = Number(id);
  return Number.isInteger(sliceId)
    ? api.send(api.orch.review.$post({ json: { slice_id: sliceId, verdict: opts.verdict, note } }))
    : usageError("review needs a slice id");
}

type Verdict = (
  api: DispatchContext,
  id: string | undefined,
  words: string[],
  opts: { verdict?: string; note?: string },
) => Promise<CommandResponse>;

const review: Verdict = (api, id, words, opts) => verdict(api, "review", id, words, opts);
const audit: Verdict = (api, id, words, opts) => verdict(api, "audit", id, words, opts);

async function pr(
  api: DispatchContext,
  groupId: string,
  _dash: string | undefined,
  opts: { title?: string },
): Promise<CommandResponse> {
  const title = opts.title;
  if (!title?.trim()) return usageError('pr needs --title "<type(scope): subject>"');
  return api.send(api.orch.pr.$post({ json: { group_id: groupId, title, body: await api.readStdin() } }));
}

async function answer(
  api: DispatchContext,
  escalationId: string | undefined,
  words: string[],
  opts: { answer?: string; ref?: string; abstain?: boolean; why?: string },
): Promise<CommandResponse> {
  const id = Number(escalationId);
  if (!Number.isInteger(id)) return usageError("answer needs an escalation id");
  if (opts.abstain) {
    return api.send(api.orch.answer.$post({ json: { escalation_id: id, abstain: true, why: opts.why ?? "" } }));
  }
  const text = opts.answer ?? words.join(" ");
  return text
    ? api.send(api.orch.answer.$post({ json: { escalation_id: id, answer: text, ref: opts.ref } }))
    : usageError('answer needs --answer "…" or --abstain');
}

async function triage(
  api: DispatchContext,
  groupId: string | undefined,
  words: string[],
  opts: { as?: string; note?: string },
): Promise<CommandResponse> {
  if (!groupId) return usageError("triage needs a group id or name");
  const disposition = opts.as;
  if (disposition !== "patch" && disposition !== "respec" && disposition !== "reject") {
    return usageError("triage needs --as patch|respec|reject");
  }
  return api.send(
    api.orch.triage.$post({
      json: { group_id: groupId, as: disposition, note: opts.note ?? words.join(" ") },
    }),
  );
}

async function draft(api: DispatchContext, groupId: string | undefined): Promise<CommandResponse> {
  return api.send(
    api.orch.draft.$post({ json: { group_id: groupId ?? process.env.ORCH_GRP_ID, card: await api.readStdin() } }),
  );
}

async function owns(
  api: DispatchContext,
  groupId: string | undefined,
  opts: { path: string[] },
): Promise<CommandResponse> {
  return opts.path.length
    ? api.send(api.orch.owns.$post({ json: { group_id: groupId ?? process.env.ORCH_GRP_ID, paths: opts.path } }))
    : usageError("owns needs at least one --path <glob>");
}

async function blocked(
  api: DispatchContext,
  groupId: string | undefined,
  opts: { path?: string; why?: string },
): Promise<CommandResponse> {
  return api.send(
    api.orch.blocked.$post({
      json: {
        group_id: groupId ?? process.env.ORCH_GRP_ID,
        path: opts.path ?? "",
        why: opts.why ?? "",
      },
    }),
  );
}

async function drop(
  api: DispatchContext,
  groupId: string | undefined,
  opts: { why?: string; commit?: string; duplicate?: string },
): Promise<CommandResponse> {
  return api.send(
    api.orch.drop.$post({
      json: {
        group_id: groupId ?? process.env.ORCH_GRP_ID,
        why: opts.why ?? "",
        commit: opts.commit,
        duplicate: opts.duplicate,
      },
    }),
  );
}

async function status(api: DispatchContext, text: string[]): Promise<CommandResponse> {
  return api.send(api.orch.status.$post({ json: { text: text.join(" ") } }));
}

/** Hands an action's result back to the dispatcher; commander's own return is void. */
type Act = <A extends unknown[]>(handler: (...args: A) => Promise<CommandResponse>) => (...args: A) => Promise<void>;

/**
 * Every command, its flags and what each one accepts.
 *
 * This is the only description of the CLI. An agent in a sandbox has no manual —
 * `orch` and `orch <command> --help` are what it reads instead — so a flag added
 * without a description here is a flag nothing can discover.
 *
 * Each handler's parameters are commander's action arguments in order —
 * positionals, then the options object — which is why `bind` can hand them over
 * untouched. A `[-]` positional is the "body on stdin" marker the role prompts
 * already type; it is declared so it parses, and named `_dash` where a handler
 * has to step over it.
 */
function buildProgram(api: DispatchContext, act: Act, out: string[], err: string[]): Command {
  const bind = <A extends unknown[]>(handler: (api: DispatchContext, ...args: A) => Promise<CommandResponse>) =>
    act((...args: A) => handler(api, ...args));

  const program = new Command("orch")
    .description("the agent's interface to the orchestrator")
    // One line, not the whole command list. A refusal an agent can act on says
    // what is wrong and where the rest is; 26 lines of usage after every error
    // buries the sentence that names the fix.
    .showHelpAfterError("(`orch <command> --help` lists what that command accepts)")
    .version(api.version)
    .exitOverride()
    .configureOutput({ writeOut: (text) => out.push(text), writeErr: (text) => err.push(text) });

  program
    .command("ctx")
    .description("the boss's context service: query <question>")
    .command("query <question...>")
    .description("ask what the blackboard, past decisions and retros already say")
    .action(bind(ctxQuery));

  program
    .command("setup")
    .description("bootstrap only, on the first turn")
    .option("--cmd <command>", "the install command to run in this container")
    .option("--none", "nothing to install")
    .action(bind(setup));

  program
    .command("ask-boss <question...>")
    .description("escalate to the boss and wait for the answer")
    .option("--severity <severity>", "blocker|advisory", "advisory")
    .option("--kind <kind>", "env|spec|boundary|design|other")
    .option("--brief <brief>", "<=20 chars, what it is about")
    .action(bind(askBoss));

  const leaseCommand = program
    .command("lease")
    .description("run a registered resource, or `lease log <id>`; never invent shell for it");
  leaseCommand
    .command("log <id>")
    .description("what a lease printed")
    .option("--grep <text>", "only lines containing TEXT")
    .action(bind(leaseLog));
  leaseCommand
    .argument("[resource]", "a registered resource name")
    .option("--arg <k=v>", "resource argument, repeatable", collect, [])
    .action(bind(lease));

  program
    .command("mail <target> [body...]")
    .description("a message to another role")
    .option("--intent <intent>", "ask|request|inform|note|decision", "inform")
    .option("--severity <severity>", "how much it matters")
    .option("--in-reply-to <n>", "the message id this answers")
    .action(bind(mail));

  program
    .command("journal")
    .description("the group's written record: add")
    .command("add")
    .description("append an entry; the body is read from stdin")
    .option("--kind <kind>", "decision|journal|retro|risk|fact", "journal")
    .option("--file <path>", "a file the entry is about, repeatable", collect, [])
    .option("--slice <n>", "the slice this belongs to")
    .action(bind(journalAdd));

  const task = program
    .command("task")
    .description("the work assigned to you: list | claim <id> | split <group_id> | done <id>");
  task
    .command("list")
    .description("what is open, with the numeric ids the other subcommands take")
    .action(bind(taskList));
  task
    .command("claim <id>")
    .description("take a task; the id is the number from `orch task list`")
    .action(bind(taskClaim));
  task
    .command("split <group_id> [-]")
    .description('cut a group into slices; a JSON array on stdin: [{"name":"…","idea":"…"}, …]')
    .action(bind(taskSplit));
  task
    .command("done <id> [-]")
    .description("close a task; the id is the number from `orch task list`")
    .option("--claim <json>", 'what changed: {"files":["src/file.ts"],"summary":"…"} — or pipe it on stdin')
    .option("--already-done <why>", "an earlier slice already covered it")
    .option("--review <note>", 'self-review when this closes a slice: "pass: <criterion> — <evidence>"')
    .action(bind(taskDone));

  program
    .command("review [slice_id] [note...]")
    .description("QA only. A verdict on one slice")
    .option("--verdict <verdict>", "pass|fail")
    .option("--note <note>", "what you ran and saw; also takeable as trailing words")
    .action(bind(review));

  program
    .command("audit [group_id] [note...]")
    .description("Auditor only. A verdict on one group")
    .option("--verdict <verdict>", "pass|fail")
    .option("--note <note>", "what you ran and saw; also takeable as trailing words")
    .action(bind(audit));

  program
    .command("pr <group_id> [-]")
    .description("Scribe only. Open the pull request; the body is read from stdin")
    .option("--title <title>", "<type(scope): subject>")
    .action(bind(pr));

  program
    .command("answer [esc_id] [answer...]")
    .description("the boss's reply to one escalation")
    .option("--answer <text>", "the answer; also takeable as trailing words")
    .option("--ref <note_id>", "the note it cites")
    .option("--abstain", "no answer; the asker decides")
    .option("--why <why>", "why you abstained")
    .action(bind(answer));

  program
    .command("triage [group_id] [note...]")
    .description("CoS only. What happens to a group that came back")
    .option("--as <disposition>", "patch|respec|reject")
    .option("--note <note>", "why; also takeable as trailing words")
    .action(bind(triage));

  program
    .command("draft [group_id] [-]")
    .description("Dispatcher/PM. The delivery card, read from stdin")
    .action(bind(draft));

  program
    .command("owns [group_id]")
    .description("Architect only. Cut a boundary around the files a role owns")
    .option("--path <glob>", "a glob inside the boundary, repeatable", collect, [])
    .action(bind(owns));

  program
    .command("blocked [group_id]")
    .description("a defect outside your boundary that stops you")
    .option("--path <file>", "the file that blocks you")
    .option("--why <why>", "what is wrong with it")
    .action(bind(blocked));

  program
    .command("drop [group_id]")
    .description("already covered elsewhere; the boss confirms")
    .option("--why <why>", "what already covers it")
    .option("--duplicate <group>", "the group that covers it")
    .option("--commit <sha>", "the commit that covers it")
    .action(bind(drop));

  program.command("status <text...>").description("one line on what you are doing right now").action(bind(status));

  return program;
}

/**
 * Commander's own refusals, turned into an exit result.
 *
 * The message is the point of them: `--clam` comes back as "unknown option
 * '--clam' (Did you mean --claim?)" instead of being accepted silently, which is
 * what left `--claim` undefined and sent the command to read a claim off a
 * terminal that was never going to produce one.
 *
 * Commander has already written the text by the time it throws — errors through
 * `writeErr`, help and `--version` through `writeOut` — so this only picks the
 * stream and the code. `error.message` is never the better source; on a help
 * throw it is the literal string "(outputHelp)".
 */
function commanderExit(error: unknown, out: string[], err: string[]): ExitResult {
  if (!(error instanceof CommanderError)) throw error;
  const stdout = out.join("").trimEnd();
  const stderr = err.join("").trimEnd();
  return {
    kind: "exit",
    code: error.exitCode === 0 ? 0 : 2,
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  };
}

export async function dispatchCommand(context: DispatchContext): Promise<DispatchResult> {
  const out: string[] = [];
  const err: string[] = [];
  let outcome: CommandResponse | undefined;
  const act: Act =
    (handler) =>
    async (...args) => {
      outcome = await handler(...args);
    };
  const program = buildProgram(context, act, out, err);
  try {
    await program.parseAsync(context.argv, { from: "user" });
  } catch (error) {
    return commanderExit(error, out, err);
  }
  if (outcome === undefined) return { kind: "exit", code: 2, stderr: program.helpInformation().trimEnd() };
  return "kind" in outcome ? outcome : { kind: "response", response: outcome };
}
