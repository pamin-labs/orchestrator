import { activeTracer } from "../../platform/observability/traces.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Ctx } from "../ctx.ts";
import { ensureSandbox, lineQueue, SANDBOX_API_KEY_HEADER, serverAddr, splitAddr, type Scope } from "./sandbox.ts";
import { sandboxKeyFor } from "./auth.ts";
import { z } from "zod";
import { jsonOr } from "../../contracts/json.ts";

/** The one field the create call is used for. */
const SessionOpened = z.looseObject({ session_id: z.string().min(1) });

/**
 * A real terminal inside a container, over the daemon's own WebSocket.
 *
 * The alternative was a Python script that forks a pty, uploaded per login, and
 * every failure it produced is listed in
 * [`053`](../../../docs/adr/053-a-terminal-in-the-container-is-a-websocket.md).
 * This file owns the wire format and nothing else knows it.
 */
/**
 * Only the login wants this. A turn, a gate and a lease want a command's output
 * and its exit code, which `execLines` gives them without putting ANSI through
 * every gate's log.
 */

/** The port execd listens on inside every container, reached through the sandbox
 *  server's proxy. Fixed by the daemon, not by us. */
const EXECD_PORT = 44772;

/**
 * The channel byte each frame opens with. Server-to-client are the reads;
 * `STDIN` is the only one we send, and it is the whole reason this file exists.
 */
const STDOUT = 0x01;
const STDERR = 0x02;
const STDIN = 0x00;

/** What a control frame says. JSON text, not binary — the channel bytes above
 *  are for the stream, these are about the session. */
type Control = { type: "resize"; cols: number; rows: number } | { type: "signal"; signal: string } | { type: "ping" };

/**
 * What the server says back on the text channel. `exit` is the one that matters:
 * it is the ending the command runner never had.
 *
 * Parsed rather than asserted. This is JSON from a daemon whose SDK does not
 * describe this endpoint, so it is data from outside and the schema is the
 * boundary — a cast here would make a missing `exit_code` read as `-1` by
 * accident rather than by rule.
 */
const ServerNote = z.looseObject({ type: z.string().optional(), exit_code: z.number().nullish() }).nullable();

export interface PtySession {
  /** Every line the command writes, ending when the process does. */
  lines: AsyncGenerator<string, { code: number; err: string }, void>;
  /** Send keystrokes. Two calls are two arrivals — see `type` below. */
  write: (bytes: string) => void;
  /** Ask the daemon to signal the process. Unlike aborting a request, this
   *  reaches it. */
  signal: (name: string) => void;
  /** Give up on the session, whatever state it is in. */
  close: () => void;
}

/**
 * A line splitter that keeps the remainder.
 *
 * A pty delivers blocks, not lines: a frame can carry half a line, three lines,
 * or a line and a half. Kept here rather than reusing the command runner's
 * because that one is fed `${text}\n` per server message and this one is fed raw
 * terminal output.
 */
function splitter(): { push: (chunk: string) => string[]; rest: () => string } {
  let held = "";
  return {
    push: (chunk) => {
      held += chunk;
      const parts = held.split("\n");
      held = parts.pop() ?? "";
      return parts;
    },
    rest: () => held,
  };
}

/**
 * Where the daemon's pty endpoints live for one sandbox, through the proxy.
 *
 * Built rather than interpolated, the way `sandboxKeyWorks` builds its probe:
 * `sandbox.server` is `host[:port]` by contract — `config.ts` rejects anything
 * else — and `new URL` is what makes that contract load-bearing, since a path or
 * a query smuggled into the value would otherwise replace this one. The id is
 * encoded rather than trusted to carry no separators.
 */
function endpoints(ctx: Ctx, sandboxId: string): { http: URL; ws: string } {
  const { protocol, authority } = splitAddr(serverAddr(ctx));
  const http = new URL(`${protocol}://${authority}`);
  http.pathname = `/v1/sandboxes/${encodeURIComponent(sandboxId)}/proxy/${EXECD_PORT}/pty`;
  return { http, ws: `${protocol === "https" ? "wss" : "ws"}://${http.host}${http.pathname}` };
}

/**
 * Open a terminal, run one command in it, and hand back the four things a login
 * needs.
 *
 * The command is written into the shell rather than passed as an argument: the
 * pty endpoint opens a session, and what runs in it is what is typed. `exec`
 * replaces the shell so the exit frame is the command's own status rather than
 * the shell's.
 */
export async function openPty(
  ctx: Ctx,
  scope: Scope,
  command: string,
  opts: { cols?: number; rows?: number; signal?: AbortSignal } = {},
): Promise<PtySession> {
  const span = activeTracer().startSpan("sandbox.pty_open");
  try {
    const sb = await ensureSandbox(ctx, scope);
    const { authority } = splitAddr(serverAddr(ctx));
    const key = await sandboxKeyFor(ctx.db, authority, ctx.config.sandbox.apiKey);
    const { http, ws: wsUrl } = endpoints(ctx, sb.id);

    // fallow-ignore-next-line security-sink -- `http` is a `URL` built by `endpoints` above: its origin comes from `sandbox.server`, which `config.ts` constrains to `host[:port]`, and its path is a literal template whose only variable is the sandbox id under `encodeURIComponent`. It is the same destination every SDK call already goes to, resolved the same way `connection()` resolves it. A non-literal URL is all fallow can see.
    const made = await fetch(http, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { [SANDBOX_API_KEY_HEADER]: key } : {}) },
      body: JSON.stringify({ cwd: "/root" }),
    });
    if (!made.ok) throw new Error(`pty session refused: HTTP ${made.status}`);
    const opened = SessionOpened.safeParse(await made.json());
    if (!opened.success) throw new Error("pty session carried no session_id");

    const socket = new WebSocket(`${wsUrl}/${opened.data.session_id}/ws`);
    socket.binaryType = "arraybuffer";
    return await drive(socket, command, opts);
  } catch (e) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    span.end();
  }
}

/**
 * The socket, as an async generator plus three verbs.
 *
 * Frames arrive faster than a consumer reads them, so they queue; the generator
 * hands them over and resolves at the exit frame or the close, whichever comes
 * first. Both are endings, which is the property the command runner did not have
 * — its stream stayed open after the process was gone.
 */
async function drive(
  socket: WebSocket,
  command: string,
  opts: { cols?: number; rows?: number; signal?: AbortSignal },
): Promise<PtySession> {
  const out = splitter();
  // The command runner's own queue: same "lines arrive faster than they are
  // read, and the end must not drop what was already pushed" problem, already
  // solved and already tested.
  const q = lineQueue();
  let ended: { code: number; err: string } | null = null;
  let stderr = "";

  const finish = (code: number) => {
    ended ??= { code, err: stderr };
    q.end();
  };

  const control = (c: Control) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(c));
  const send = (text: string) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const body = new TextEncoder().encode(text);
    const frame = new Uint8Array(body.length + 1);
    frame[0] = STDIN;
    frame.set(body, 1);
    socket.send(frame);
  };

  await new Promise<void>((ready, fail) => {
    socket.onopen = () => ready();
    socket.onerror = () => fail(new Error("pty websocket refused"));
  });

  socket.onmessage = (e) => {
    if (typeof e.data === "string") {
      const note = jsonOr(e.data, ServerNote, null);
      if (note?.type === "exit") finish(note.exit_code ?? -1);
      return;
    }
    if (!(e.data instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(e.data);
    const text = new TextDecoder().decode(bytes.subarray(1));
    if (bytes[0] === STDERR) stderr += text;
    if (bytes[0] !== STDOUT && bytes[0] !== STDERR) return;
    q.push(out.push(text));
  };
  // A close without an exit frame is still an ending, and `-1` is what the
  // command runner reports for a status it never saw.
  socket.onclose = () => finish(ended?.code ?? -1);
  socket.onerror = () => finish(-1);
  opts.signal?.addEventListener("abort", () => socket.close(), { once: true });

  // Explicitly, before anything runs: a pty with no size defaults to 80 columns
  // and the CLI wraps its URL mid-token, which is the one thing the link handed
  // to the boss must not do.
  control({ type: "resize", cols: opts.cols ?? 400, rows: opts.rows ?? 200 });
  send(`exec ${command}\r`);

  const lines = (async function* () {
    yield* q.drain();
    const tail = out.rest().trim();
    if (tail) yield tail;
    return ended ?? { code: -1, err: stderr };
  })();

  return {
    lines,
    write: send,
    signal: (name) => control({ type: "signal", signal: name }),
    close: () => socket.close(),
  };
}
