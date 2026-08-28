#!/usr/bin/env bun
/** Agent-facing CLI over the sandbox mailbox or the local HTTP endpoint. */

import { hc } from "hono/client";
import { type Json, JsonValue, jsonOr } from "../contracts/json.ts";
import { displayJson, type JsonReply, ProtocolResponse, readJsonResponse } from "../contracts/protocol.ts";
import type { OrchType } from "../http/routes/orch.ts";
import { VERSION } from "../platform/process/version.ts";
import { dispatchCommand } from "./commands/dispatch.ts";

/**
 * The port is restated here rather than read from config, deliberately.
 *
 * This file is provisioned into a sandbox on its own (`sandbox.ts` -> `provision`)
 * and run there by `bun run`; a config loader would find no yaml under `ORCH_ROOT`
 * and answer with its own defaults — this same literal, by a longer route and a
 * whole schema. `composition/server.ts` sets `ORCH_URL` for what it spawns, and in
 * a sandbox `ORCH_MAILBOX` takes every request to the file transport below.
 */
const URL_BASE = process.env.ORCH_URL ?? "http://127.0.0.1:47821";
const TOKEN = process.env.ORCH_TOKEN ?? "";
const MAILBOX = process.env.ORCH_MAILBOX ?? "";
const configuredMailboxTimeout = Number(process.env.ORCH_MAILBOX_TIMEOUT_MS ?? 1_200_000);
const MAILBOX_TIMEOUT_MS =
  Number.isFinite(configuredMailboxTimeout) && configuredMailboxTimeout > 0 ? configuredMailboxTimeout : 1_200_000;

async function viaMailbox(
  method: string,
  path: string,
  payload: Json | undefined,
  requestId: string,
  idempotencyKey?: string,
): Promise<ProtocolResponse> {
  const id = crypto.randomUUID();
  const requestPath = `${MAILBOX}/req/${id}.json`;
  const responsePath = `${MAILBOX}/res/${id}.json`;
  await Bun.write(
    requestPath,
    JSON.stringify({
      id,
      method,
      path,
      token: TOKEN,
      body: payload,
      request_id: requestId,
      idempotency_key: idempotencyKey,
    }),
  );
  const expires = Date.now() + MAILBOX_TIMEOUT_MS;
  while (Date.now() < expires) {
    const file = Bun.file(responsePath);
    if (await file.exists()) {
      const answer = jsonOr(await file.text(), ProtocolResponse, {
        status: 502,
        body: { error: "mailbox returned an invalid response" },
      });
      await file.delete().catch(() => {});
      return answer;
    }
    await Bun.sleep(120);
  }
  await Bun.file(requestPath)
    .delete()
    .catch(() => {});
  await Bun.file(responsePath)
    .delete()
    .catch(() => {});
  return { status: 504, body: { error: `mailbox request timed out after ${MAILBOX_TIMEOUT_MS}ms` } };
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Exported for the test that pins which methods carry an idempotency key. A
 * duplicate `Idempotency-Key` on a GET is harmless; a missing one on a POST
 * means a retried lease can run its side effect twice, and nothing else in the
 * CLI would notice.
 */
export function transportMetadata(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  const method = input instanceof Request ? input.method : (init?.method ?? "GET");
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  const requestId = crypto.randomUUID();
  const idempotencyKey = IDEMPOTENT_METHODS.has(method.toUpperCase()) ? undefined : crypto.randomUUID();
  headers.set("X-Request-ID", requestId);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return { method, headers, requestId, idempotencyKey };
}

function requestPayload(init?: Parameters<typeof fetch>[1]): Json | undefined {
  return typeof init?.body === "string" ? JsonValue.parse(JSON.parse(init.body)) : undefined;
}

const transport = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const { method, headers, requestId, idempotencyKey } = transportMetadata(input, init);
    // fallow-ignore-next-line security-sink -- `input` is built by the generated Hono client from `URL_BASE`, which is `ORCH_URL` or loopback, and the path is a route name from this file's own commands. This branch is the developer one: inside a sandbox `ORCH_MAILBOX` is set and every request goes to the file transport below, never to the network.
    if (!MAILBOX) return fetch(input, { ...init, headers });
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const answer = await viaMailbox(
      method,
      `${url.pathname}${url.search}`,
      requestPayload(init),
      requestId,
      idempotencyKey,
    );
    return Response.json(answer.body, { status: answer.status });
  },
  { preconnect: fetch.preconnect },
);

const orch = hc<OrchType>(`${URL_BASE}/orch/v1`, {
  fetch: transport,
  headers: { "x-orch-token": TOKEN },
});

async function result(response: JsonReply): Promise<ProtocolResponse> {
  const body = await readJsonResponse(response);
  return body.ok
    ? { status: response.status, body: body.data }
    : { status: 502, body: { error: "orchestrator returned a non-JSON response" } };
}

async function send(request: Promise<JsonReply>): Promise<ProtocolResponse> {
  try {
    return await result(await request);
  } catch (error) {
    return {
      status: 502,
      body: {
        error:
          `cannot reach the orchestrator at ${URL_BASE}: ${error instanceof Error ? error.message : String(error)}\n` +
          "ORCH_MAILBOX is unset, so this process has no sandbox transport.",
      },
    };
  }
}

/**
 * What was piped in, or nothing when there is a terminal on the other end.
 *
 * `Bun.stdin.text()` on a tty waits for a human to type and press ctrl-D. Four
 * commands read stdin, so running any of them at a prompt without the input they
 * expect hung with no output at all — and the usage message that would have said
 * what was missing was on the far side of the wait.
 *
 * A tty means nothing was piped, which is the case the callers already handle.
 */
async function readStdin(): Promise<string> {
  return process.stdin.isTTY ? "" : await Bun.stdin.text();
}

export async function main(argv: string[]): Promise<number> {
  const execution = await dispatchCommand({
    orch,
    argv,
    version: VERSION,
    send,
    readStdin,
  });
  if (execution.kind === "exit") {
    if (execution.stdout !== undefined) console.log(execution.stdout);
    if (execution.stderr !== undefined) console.error(execution.stderr);
    return execution.code;
  }
  if (execution.response.status >= 400) {
    console.error(displayJson(execution.response.body, 2));
    return 1;
  }
  console.log(displayJson(execution.response.body, 2));
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
