import type { Ctx } from "../api.ts";
import { liveSandboxes, MAILBOX_DIR } from "./sandbox.ts";

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
 * costs 1-5ms a call (docs/decisions/005).
 */

/** Enough to make a request; anything else is the orchestrator's business. */
interface Envelope {
  id: string;
  method: string;
  path: string;
  token: string;
  body?: unknown;
}

const POLL_MS = 150;

/**
 * Deliver one request and answer it.
 *
 * A lease can block for hours, so this is never awaited by the poll loop — the
 * request file is deleted first, which is what keeps a slow call from being
 * dispatched twice on the next tick.
 */
async function serve(sb: ReturnType<typeof liveSandboxes>[number], base: string, path: string): Promise<void> {
  let env: Envelope;
  try {
    env = JSON.parse(await sb.files.readFile(path)) as Envelope;
  } catch {
    await sb.files.deleteFiles([path]).catch(() => {});
    return;
  }
  await sb.files.deleteFiles([path]).catch(() => {});

  let answer: { status: number; text: string };
  try {
    const headers: Record<string, string> = { "x-orch-token": env.token ?? "" };
    if (env.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${env.path}`, {
      method: env.method,
      headers,
      body: env.body === undefined ? undefined : JSON.stringify(env.body),
    });
    answer = { status: res.status, text: await res.text() };
  } catch (e) {
    // The agent gets a real failure rather than hanging on a response that will
    // never come. Blocking forever is the one outcome worse than an error.
    answer = { status: 502, text: `orchestrator unreachable: ${e}` };
  }
  await sb.files
    .writeFiles([{ path: `${MAILBOX_DIR}/res/${env.id}.json`, data: JSON.stringify(answer), mode: 0o644 }])
    .catch(() => {});
}

/**
 * Poll every connected sandbox for requests. Returns a stop function.
 *
 * One loop for all sandboxes rather than one per group: a search is ~1ms, so
 * ten groups cost ten milliseconds every 150, and there is no per-sandbox
 * lifecycle to get wrong when a group dissolves.
 */
export function startMailbox(ctx: Ctx): () => void {
  const base = `http://127.0.0.1:${ctx.config.port ?? 47821}`;

  let stopped = false;

  const tick = async () => {
    for (const sb of liveSandboxes()) {
      try {
        for (const f of await sb.files.search({ path: `${MAILBOX_DIR}/req`, pattern: "*.json" })) {
          if (f.path) void serve(sb, base, f.path);
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
  };
}
