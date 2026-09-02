import { lineQueue } from "../../src/mech/sandbox/sandbox.ts";
import type { PtySession } from "../../src/mech/sandbox/pty.ts";

/**
 * A terminal that says what a test tells it to, and records what was typed.
 *
 * The real one is a WebSocket to execd (ADR 053), so it cannot be reached from
 * a unit test — but the properties worth testing are on this side of it: which
 * line the token is recognised on, whether the code and its Enter arrive as two
 * keystrokes, and what happens when the session ends without saying anything.
 */
export interface FakePty extends PtySession {
  /** Every `write`, in order. The login's `submit` must produce two. */
  typed: string[];
  /** Signals the login asked the daemon to send. */
  signals: string[];
  /** Hand the CLI's next line to whoever is reading. */
  say: (line: string) => void;
  /** End the session the way an exit frame does. */
  exit: (code?: number) => void;
}

/**
 * `lines` never ends on its own. A test that wants an ending calls `exit`, which
 * is the point: the transport this replaced had no ending at all, and a fake
 * that resolved when it ran out of scripted output would hide that.
 */
export function fakePty(scripted: string[] = []): FakePty {
  const typed: string[] = [];
  const signals: string[] = [];
  // The same queue the real client uses, so this double does not become a second
  // implementation of "lines arrive before they are read" that can drift from it.
  const q = lineQueue();
  let ended: { code: number; err: string } | null = null;
  q.push(scripted);

  const finish = (code: number) => {
    ended ??= { code, err: "" };
    q.end();
  };

  const lines = (async function* () {
    yield* q.drain();
    return ended ?? { code: -1, err: "" };
  })();

  return {
    lines,
    typed,
    signals,
    write: (bytes) => {
      typed.push(bytes);
    },
    signal: (name) => {
      signals.push(name);
    },
    close: () => finish(-1),
    say: (line) => q.push([line]),
    exit: (code = 0) => finish(code),
  };
}
