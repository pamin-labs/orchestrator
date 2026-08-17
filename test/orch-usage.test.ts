import { expect, test } from "bun:test";
import { main } from "../src/orch/cli.ts";
import { transportMetadata } from "../src/orch/cli.ts";

/**
 * The usage errors are the CLI's contract with the agents that read them.
 *
 * An agent inside a sandbox has no documentation and no operator; the string it
 * gets back when it calls a command wrongly is the whole of what it knows. Every
 * message here names the flag and shows the shape, which is why they are worth
 * pinning: a message that says only "invalid arguments" costs a turn, and the
 * lease it was in the middle of.
 *
 * These paths return before any request is made, so nothing here needs a server.
 */

async function usage(argv: string[]): Promise<{ code: number; message: string }> {
  const errors: string[] = [];
  const error = console.error;
  console.error = (...values: unknown[]) => errors.push(values.join(" "));
  try {
    const code = await main(argv);
    return { code, message: errors.join("\n") };
  } finally {
    console.error = error;
  }
}

test("task done names the id source and the claim shape it wants", async () => {
  const byTitle = await usage(["task", "done", "make the thing work"]);
  expect(byTitle.code).toBe(2);
  // The title is what an agent reaches for first, so the message says where the
  // number comes from rather than only that a number was expected.
  expect(byTitle.message).toContain("orch task list");

  const badJson = await usage(["task", "done", "7", "--claim", "not json"]);
  expect(badJson.code).toBe(2);
  expect(badJson.message).toContain('{"files":["src/file.ts"],"summary":"what changed"}');
});

test("task done refuses to close a task with no account of what changed", async () => {
  const empty = await usage(["task", "done", "7", "--claim", ""]);
  expect(empty.code).toBe(2);
  expect(empty.message).toContain("--already-done");
});

test("an unknown task subcommand says which one it was", async () => {
  const result = await usage(["task", "finish"]);
  expect(result.code).toBe(2);
  expect(result.message).toContain("finish");
});

test("review and audit each name the identifier they take", async () => {
  const review = await usage(["review"]);
  expect(review.code).toBe(2);
  expect(review.message).toContain("slice id");

  const audit = await usage(["audit"]);
  expect(audit.code).toBe(2);
  expect(audit.message).toContain("group id or name");
});

test("a verdict is pass or fail, and the message says so", async () => {
  const missing = await usage(["review", "12"]);
  expect(missing.code).toBe(2);
  expect(missing.message).toContain("--verdict pass|fail");

  const wrong = await usage(["review", "12", "--verdict", "maybe"]);
  expect(wrong.code).toBe(2);
  expect(wrong.message).toContain("--verdict pass|fail");
});

test("answer accepts a written answer or an abstention, and says which", async () => {
  const notAnId = await usage(["answer", "the-second-one"]);
  expect(notAnId.code).toBe(2);
  expect(notAnId.message).toContain("escalation id");

  const noContent = await usage(["answer", "3"]);
  expect(noContent.code).toBe(2);
  expect(noContent.message).toContain("--abstain");
});

test("triage lists its three dispositions rather than rejecting silently", async () => {
  const noGroup = await usage(["triage"]);
  expect(noGroup.code).toBe(2);
  expect(noGroup.message).toContain("group id or name");

  const noDisposition = await usage(["triage", "auth-rework"]);
  expect(noDisposition.code).toBe(2);
  expect(noDisposition.message).toContain("patch|respec|reject");

  const invented = await usage(["triage", "auth-rework", "--as", "defer"]);
  expect(invented.code).toBe(2);
  expect(invented.message).toContain("patch|respec|reject");
});

test("only non-idempotent methods carry an idempotency key", () => {
  // A retried POST that re-ran its side effect is the failure this prevents, so
  // the split is asserted rather than assumed from the method list.
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
    expect(transportMetadata("http://x/orch/v1/tasks", { method }).idempotencyKey).toBeUndefined();
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
    expect(transportMetadata("http://x/orch/v1/tasks", { method }).idempotencyKey).toBeString();
  }
});

test("every request is correlatable, and a Request carries its own method and headers", () => {
  const plain = transportMetadata("http://x/orch/v1/tasks");
  expect(plain.method).toBe("GET");
  expect(plain.headers.get("X-Request-ID")).toBeString();

  const request = new Request("http://x/orch/v1/tasks", { method: "POST", headers: { "x-orch-token": "t" } });
  const fromRequest = transportMetadata(request);
  expect(fromRequest.method).toBe("POST");
  expect(fromRequest.headers.get("x-orch-token")).toBe("t");
  expect(fromRequest.headers.get("Idempotency-Key")).toBe(fromRequest.idempotencyKey ?? null);
  expect(fromRequest.requestId).not.toBe(plain.requestId);
});
