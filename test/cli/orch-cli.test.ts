import { expect, test } from "bun:test";
import { hc } from "hono/client";
import { main } from "../../src/orch/cli.ts";
import { dispatchCommand, kvArgs } from "../../src/orch/commands/dispatch.ts";
import type { OrchType } from "../../src/http/routes/orch.ts";
import { VERSION } from "../../src/platform/process/version.ts";
import { Id } from "../../src/contracts/fields.ts";
import { MailBody } from "../../src/api/orch/messaging.ts";

async function captureMain(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values) => stdout.push(values.join(" "));
  console.error = (...values) => stderr.push(values.join(" "));
  try {
    return { code: await main(argv), stdout, stderr };
  } finally {
    console.log = log;
    console.error = error;
  }
}

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

/**
 * What the argv turned into on the wire.
 *
 * Parsing is only interesting where it reaches the request, so the assertions
 * below are on the JSON body rather than on an intermediate flag bag: a flag that
 * parses and then lands in the wrong field is the failure worth catching.
 */
async function run(
  argv: string[],
  stdin = "",
): Promise<{ sent: Sent[]; stderr: string | undefined; code: number | undefined }> {
  const sent: Sent[] = [];
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input instanceof Request ? input : input.toString(), init);
      const text = await request.text();
      const url = new URL(request.url);
      sent.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        body: text ? JSON.parse(text) : undefined,
      });
      return Response.json({ ok: true });
    },
    { preconnect: fetch.preconnect },
  );
  const result = await dispatchCommand({
    orch: hc<OrchType>("http://orch.test/orch/v1", { fetch: transport }),
    argv,
    version: VERSION,
    send: async (request) => ({ status: (await request).status, body: {} }),
    readStdin: async () => stdin,
  });
  return result.kind === "exit"
    ? { sent, stderr: result.stderr, code: result.code }
    : { sent, stderr: undefined, code: undefined };
}

const body = (sent: Sent[]) => sent[0]?.body;

test("version and usage retain their public output and exit codes", async () => {
  expect(await captureMain(["--version"])).toEqual({ code: 0, stdout: [VERSION], stderr: [] });

  const help = await captureMain([]);
  expect(help.code).toBe(2);
  expect(help.stdout).toEqual([]);
  // Generated from the command definitions now, so this pins that every command
  // still reaches the one page an agent in a sandbox can read.
  const usage = help.stderr.join("\n");
  expect(usage).toStartWith("Usage: orch");
  for (const command of [
    "ctx",
    "setup",
    "ask-boss",
    "lease",
    "mail",
    "journal",
    "task",
    "review",
    "audit",
    "pr",
    "answer",
    "triage",
    "draft",
    "owns",
    "blocked",
    "drop",
    "status",
  ]) {
    expect(usage).toContain(command);
  }
});

test("an unknown command is a usage error that names the nearest real one", async () => {
  const result = await captureMain(["not-a-command"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toEqual([]);
  expect(result.stderr[0]).toContain("unknown command 'not-a-command'");

  // The suggestion is the point: a typo used to be accepted as a command name.
  const near = await captureMain(["task", "nope"]);
  expect(near.code).toBe(2);
  expect(near.stderr[0]).toContain("unknown command 'nope'");
  expect(near.stderr[0]).toContain("Did you mean done?");
});

test("an unknown option is refused instead of silently leaving the real one unset", async () => {
  // `--clam` parsed as a flag nothing reads, so `--claim` stayed undefined and
  // `task done` went to read the claim from a terminal that never answered.
  const result = await captureMain(["task", "done", "7", "--clam", "x"]);
  expect(result.code).toBe(2);
  expect(result.stderr[0]).toContain("unknown option '--clam'");
  expect(result.stderr[0]).toContain("Did you mean --claim?");
});

test("--flag=value is the same flag as --flag value", async () => {
  const inline = await run(["task", "done", "7", '--claim={"files":["a.ts"],"summary":"x"}']);
  const spaced = await run(["task", "done", "7", "--claim", '{"files":["a.ts"],"summary":"x"}']);
  expect(body(inline.sent)).toEqual({ task_id: 7, claim: { files: ["a.ts"], summary: "x" } });
  expect(body(spaced.sent)).toEqual(body(inline.sent));

  // An inline value ends the flag, so the next word is a positional and not
  // swallowed as its value.
  const mail = await run(["mail", "--intent=request", "qa", "please", "verify"]);
  expect(body(mail.sent)).toMatchObject({ target: "qa", intent: "request", body: "please verify" });
});

test("repeated options accumulate instead of overwriting", async () => {
  const journal = await run(["journal", "add", "--file", "a.ts", "--file", "b.ts"], "note");
  expect(body(journal.sent)).toMatchObject({ files: ["a.ts", "b.ts"], body: "note" });

  // The overturned decision travels as an id, because prose saying "this replaces the
  // earlier gate order" is invisible to the index and the earlier one keeps being
  // answered with. A flag is a string on the wire; `Id` is what turns it into one.
  const reversal = await run(["journal", "add", "--kind", "decision", "--supersedes", "12"], "new order");
  expect(body(reversal.sent)).toMatchObject({ kind: "decision", supersedes: "12" });

  const paths = await run(["owns", "grp", "--path", "src/**", "--path", "test/**"]);
  expect(body(paths.sent)).toEqual({ group_id: "grp", paths: ["src/**", "test/**"] });
});

test("--arg k=v pairs parse, and a value containing = survives", async () => {
  const lease = await run(["lease", "build", "--arg", "target=release", "--arg", "flags=-O2 -g"]);
  expect(body(lease.sent)).toEqual({ resource: "build", args: { target: "release", flags: "-O2 -g" } });
  expect(kvArgs(["q=a=b"])).toEqual({ q: "a=b" });
});

test("malformed --arg entries are dropped rather than sent as junk", async () => {
  const lease = await run(["lease", "build", "--arg", "novalue"]);
  expect(body(lease.sent)).toEqual({ resource: "build", args: {} });
  expect(kvArgs([])).toEqual({});
});

test("free text keeps arriving as one joined line", async () => {
  expect(body((await run(["status", "waiting", "on", "QA"])).sent)).toEqual({ text: "waiting on QA" });
  expect(body((await run(["ctx", "query", "who", "owns", "auth"])).sent)).toEqual({ question: "who owns auth" });
  expect(body((await run(["ask-boss", "--kind", "scope", "is", "this", "in", "scope"])).sent)).toMatchObject({
    question: "is this in scope",
    severity: "advisory",
  });
  // A trailing note is still readable as loose words when --note is absent.
  expect(body((await run(["review", "12", "--verdict", "pass", "ran", "the", "suite"])).sent)).toEqual({
    slice_id: 12,
    verdict: "pass",
    note: "ran the suite",
  });
});

test("a bare -- hands the rest through as text, flags and all", async () => {
  // Commander mixes the words after `--` back into the command's arguments, so
  // they land in the variadic positional rather than being parsed as options.
  const status = await run(["status", "--", "--not-a-flag", "-h"]);
  expect(body(status.sent)).toEqual({ text: "--not-a-flag -h" });
  expect(status.stderr).toBeUndefined();
});

test("-h asks for help, it is not a question for the boss", async () => {
  // `orch ask-boss -h` filed an escalation whose entire text was "-h" and then
  // waited for an answer.
  const result = await captureMain(["ask-boss", "-h"]);
  expect(result.code).toBe(0);
  expect(result.stdout.join("\n")).toContain("Usage: orch ask-boss");
  expect(result.stderr).toEqual([]);
});

test("a numeric flag arrives as a string and the schema takes it", () => {
  // `orch` hands every flag over as text, so each numeric field had to be
  // converted somewhere. It was converted at the call site — twice written out,
  // and once forgotten: `orch mail x --in-reply-to 5` sent the string and came
  // back "in_reply_to: Invalid input: expected number, received string", which
  // names no fix an agent could apply. The conversion is in the field now.
  expect(MailBody.parse({ target: "qa", intent: "ask", body: "?", in_reply_to: "5" }).in_reply_to).toBe(5);
  expect(MailBody.parse({ target: "qa", intent: "ask", body: "?", in_reply_to: 5 }).in_reply_to).toBe(5);

  // And it stays a boundary. `z.coerce.number()` would have been shorter and
  // would accept every one of these: a bare `--slice` parses to `true`, which
  // Number() reads as the entirely plausible id 1.
  for (const junk of [true, "", " 5 ", "5.5", "abc", 0, -1]) {
    expect(Id.safeParse(junk).success).toBe(false);
  }
});

test("pr resolve reaches the route, and the thread id is a flag rather than a position", async () => {
  // A verb with a route and no command is a route an agent cannot reach: the
  // mailbox replays what `orch` sends, so anything not declared here does not
  // exist as far as a sandbox is concerned.
  const withNote = await run([
    "pr",
    "resolve",
    "--thread",
    "THREAD_ABC",
    "--group",
    "7",
    "--note",
    "rebased onto the new helper",
  ]);
  expect(withNote.sent[0]).toMatchObject({
    method: "POST",
    path: "/orch/v1/pr/resolve",
    body: { group_id: "7", thread_id: "THREAD_ABC", note: "rebased onto the new helper" },
  });

  // Named, not positional. Two ids of the same shape next to each other is an
  // order nothing checks: a group id in the thread field resolves nothing and
  // reports a thread that does not exist, which reads as GitHub's fault.
  const swapped = await run(["pr", "resolve", "THREAD_ABC", "7"]);
  expect(swapped.code).toBe(2);
  expect(swapped.sent).toEqual([]);

  // The group defaults to the caller's, so an agent replying to a review of its
  // own PR types one flag.
  process.env.ORCH_GRP_ID = "4";
  try {
    const mine = await run(["pr", "resolve", "--thread", "THREAD_ABC"]);
    expect(mine.sent[0]?.body).toMatchObject({ group_id: "4", thread_id: "THREAD_ABC" });
  } finally {
    delete process.env.ORCH_GRP_ID;
  }

  // And no thread is a refusal that names the flag, not a request with an empty id.
  const bare = await run(["pr", "resolve"]);
  expect(bare.code).toBe(2);
  expect(bare.stderr).toContain("--thread");
  expect(bare.sent).toEqual([]);

  // The subcommand does not shadow `orch pr <group_id>`.
  const open = await run(["pr", "9", "--title", "fix(x): y"], "body");
  expect(open.sent[0]).toMatchObject({ path: "/orch/v1/pr", body: { group_id: "9", title: "fix(x): y" } });
});
