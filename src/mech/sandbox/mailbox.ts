import { jsonOr } from "../../contracts/json.ts";
import { errText } from "../util/text.ts";
import { consola } from "consola";
import { z } from "zod";
import type { Ctx } from "../../ctx.ts";
import { JsonValue } from "../../contracts/json.ts";
import { ProtocolResponse, readJsonResponse } from "../../contracts/protocol.ts";
import { FILE_MODE, liveSandboxes, MAILBOX_DIR, writeInto } from "./sandbox.ts";

export type MailboxSandbox = {
  files: Pick<ReturnType<typeof liveSandboxes>[number]["files"], "readFile" | "deleteFiles" | "writeFiles">;
};

/**
 * The host end of the agent's only way out.
 *
 * An agent's `orch` writes a request file inside its sandbox; this reads it,
 * replays it against the orchestrator's own HTTP server, and writes the answer
 * back. Every route, every token check and every blocking wait keeps working
 * unchanged — the transport moved, the interface did not.
 *
 * Why not just let the sandbox reach 127.0.0.1: `host.docker.internal` is a
 * Docker Desktop invention and has no equivalent on Linux, so relying on it
 * would quietly make this macOS-only. The files API is the same everywhere and
 * costs 1-5ms a call (docs/adr/005).
 */

/** Enough to make a request; anything else is the orchestrator's business. */
const SafeId = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(128);
const ReplyId = z.looseObject({ id: SafeId });
const Envelope = z.object({
  // This becomes part of the response filename, so accept only one safe path segment.
  id: SafeId,
  method: z.enum(["GET", "POST"]),
  path: z.string(),
  token: z.string(),
  body: JsonValue.optional(),
  request_id: SafeId,
  idempotency_key: SafeId.optional(),
});

type Envelope = z.infer<typeof Envelope>;

const POLL_MS = 150;

/**
 * Deliver one request and answer it.
 *
 * A lease can block for hours, so this is never awaited by the poll loop — the
 * request file is deleted first, which is what keeps a slow call from being
 * dispatched twice on the next tick.
 */
export async function serve(sb: MailboxSandbox, base: string, path: string, signal?: AbortSignal): Promise<void> {
  const raw = await sb.files.readFile(path).catch(() => null);
  const value = jsonOr(raw, JsonValue, null);
  const id = ReplyId.safeParse(value).data?.id;
  const env = Envelope.safeParse(value).data;
  await sb.files.deleteFiles([path]).catch(() => {});
  if (!env) {
    if (id) await reply(sb, id, { status: 400, body: { error: "invalid mailbox request" } });
    return;
  }

  let answer: ProtocolResponse;
  // `/orch/v1/*` checks a token on every route; `/api/v1/*` checks nothing, because
  // its only caller was a browser on 127.0.0.1. The mailbox made the sandbox a
  // caller on 127.0.0.1 too, and `orch` is not the only thing that can drop a
  // file in `req/` — so without this an agent answers its own DRAFT, accepts its
  // own slices and overwrites the boss's credentials. Hard constraint 3: this is
  // an `if`, not a line in a role prompt.
  //
  // Checked on the *normalised* path, and the same normalised string is what
  // gets sent. The first version tested `env.path` raw and then handed that raw
  // string to `fetch`, which parses it as a URL — so `/orch/v1/../api/auth` passed
  // the prefix test and arrived as `/api/v1/auth`, and every route the guard exists
  // to hide was reachable from inside the sandbox. `%2e%2e` and `/orch/v1/x/../../`
  // did the same. Whatever is judged has to be what is sent.
  const url = normalise(base, env.path);
  if (!url) {
    await reply(sb, env.id, { status: 403, body: { error: `not reachable from a sandbox: ${env.path}` } });
    return;
  }
  try {
    const headers: Record<string, string> = {
      "x-orch-token": env.token ?? "",
      "x-request-id": env.request_id,
      ...(env.idempotency_key ? { "idempotency-key": env.idempotency_key } : {}),
    };
    if (env.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url, {
      method: env.method,
      headers,
      ...(env.body === undefined ? {} : { body: JSON.stringify(env.body) }),
      ...(signal ? { signal } : {}),
    });
    const body = await readJsonResponse(res);
    answer = body.ok
      ? { status: res.status, body: body.data }
      : { status: 502, body: { error: "orchestrator returned a non-JSON response" } };
  } catch (e) {
    // The agent gets a real failure rather than hanging on a response that will
    // never come. Blocking forever is the one outcome worse than an error.
    answer = { status: 502, body: { error: `orchestrator unreachable: ${errText(e)}` } };
  }
  await reply(sb, env.id, answer);
}

/**
 * The absolute URL to replay, or null when the request is not the sandbox's to make.
 *
 * The query string is kept — `orch lease log --grep` is a GET with one — but the
 * host is not: anything that parses to a different origin, or to a path outside
 * `/orch/v1/`, is refused rather than repaired.
 */
export function normalise(base: string, path: string): string | null {
  if (!path.startsWith("/")) return null;
  let u: URL;
  try {
    u = new URL(base + path);
  } catch {
    return null;
  }
  if (u.origin !== new URL(base).origin) return null;
  if (!u.pathname.startsWith("/orch/v1/")) return null;
  return `${u.origin}${u.pathname}${u.search}`;
}

/**
 * Every path out of `serve` writes one, or the agent blocks forever.
 *
 * Which is why the write is retried rather than dropped. It used to end in
 * `.catch(() => {})` directly under that sentence — the comment was right and
 * the code disagreed with it, and the disagreement is the whole failure: the
 * agent's `orch` polls for this file with no deadline, so one reset socket on
 * the upload is an agent waiting for a turn's worth of clock on a reply that was
 * thrown away.
 *
 * `writeInto` gives it the one retry a local socket is worth. If that fails too
 * there is nothing left to write the answer with, so it is logged rather than
 * swallowed — the turn's own clock is what ends it from there.
 */
function reply(sb: MailboxSandbox, id: string, answer: ProtocolResponse): Promise<void> {
  return writeInto(sb, [
    { path: `${MAILBOX_DIR}/res/${id}.json`, data: JSON.stringify(answer), mode: FILE_MODE },
  ]).catch((e: unknown) => {
    consola.warn(`mailbox: could not answer ${id}, the agent waits out its turn clock: ${errText(e)}`);
  });
}

/**
 * Poll every connected sandbox for requests. Returns a stop function.
 *
 * One loop for all sandboxes rather than one per group: a search is ~1ms, so
 * ten groups cost ten milliseconds every 150, and there is no per-sandbox
 * lifecycle to get wrong when a group dissolves.
 */
export function startMailbox(ctx: Ctx): () => void {
  const base = `http://127.0.0.1:${ctx.config.port}`;
  const lifecycle = new AbortController();

  let stopped = false;

  const tick = async () => {
    for (const sb of liveSandboxes()) {
      try {
        for (const f of await sb.files.search({ path: `${MAILBOX_DIR}/req`, pattern: "*.json" })) {
          if (f.path) void serve(sb, base, f.path, lifecycle.signal);
        }
      } catch {
        // A sandbox that has gone away answers nothing; the watchdog owns that.
      }
    }
  };

  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, POLL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    lifecycle.abort(new Error("mailbox stopped"));
  };
}
