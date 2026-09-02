import { expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PTY_PATH, PYTHON_FLAGS, PTY_RUNNER } from "../../src/mech/sandbox/login.ts";
import { tempDir } from "../support/temp.ts";

/**
 * The pty runner, run under the name it is installed as.
 *
 * `claude setup-token` is a TUI, so the login supplies a terminal. The runner
 * was installed at `/opt/orch/pty.py` — and Python puts a script's own
 * directory at `sys.path[0]`, so its own first line `import pty` resolved to
 * the file being run.
 */
/**
 * `pty.fork` did not exist, the traceback went to a stream the login only reads
 * for a URL, and every login was reported as "claude printed no login link — it
 * needs a pty": which it does, and which this was supplying.
 */
/**
 * The name is what is under test, so the file is written with `basename(PTY_PATH)`
 * rather than a name chosen here. Reproduced in `orch-agent:latest` before the
 * rename and fixed by it alone: `claude setup-token` then prints its link and
 * its paste prompt.
 */
const python = Bun.which("python3");

/**
 * The decoy is the test. Renaming the runner closed the self-import and nothing
 * else: `/opt/orch` outlives the server that writes into it, so the old
 * `pty.py` and its `__pycache__` stayed beside the renamed file and `import pty`
 * found them instead. Reproduced in the live utility container — the traceback
 * still read `File "/opt/orch/pty.py", line 4` under the new name.
 */
const decoy = 'raise SystemExit("sys.path[0] won: a file beside the runner was imported as pty")\n';

test.skipIf(!python)("a stale module beside the runner cannot be imported instead", () => {
  const dir = tempDir("orch-pty-");
  writeFileSync(join(dir, "pty.py"), decoy);
  const at = join(dir, basename(PTY_PATH));
  writeFileSync(at, PTY_RUNNER);
  // Launched the way production launches it, flags and all — asserting on the
  // command string would pass against a `-P` that is never actually passed.
  // `printf` writes and exits, so the runner's own loop and teardown are what
  // runs rather than anything about a CLI.
  const r = Bun.spawnSync([python!, ...PYTHON_FLAGS, at, "printf", "orch-pty-works"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(r.stderr.toString()).not.toContain("has no attribute");
  expect(r.stderr.toString()).not.toContain("sys.path[0] won");
  expect(r.stdout.toString()).toContain("orch-pty-works");
});

/**
 * The structural half. A hyphen is not a Python identifier, so no `import` can
 * name this file whatever else is dropped into the directory beside it — which
 * a merely-different `.py` name would not survive.
 */
test("no import statement can reach the runner's own filename", () => {
  const stem = basename(PTY_PATH, ".py");
  expect(stem).not.toMatch(/^[A-Za-z_]\w*$/);
  const imported =
    /^import (.+)$/m
      .exec(PTY_RUNNER)?.[1]
      ?.split(",")
      .map((m) => m.trim()) ?? [];
  expect(imported.length).toBeGreaterThan(0);
  expect(imported).not.toContain(stem);
});

/**
 * What the runner sends has to be the key that submits, not the byte a file ends
 * a line with.
 *
 * Enter on a terminal is CR. Sent as LF, claude-code 2.1.233 accepted every
 * character — the code echoed back as asterisks — and never submitted, so the
 * paste box visibly did nothing. Measured: the same run, handed a bare `\r`
 * afterwards, answered `OAuth error: ... 400`. The code had arrived all along
 * and was waiting on a key it was never sent.
 */
/**
 * The stand-in reads raw bytes and answers only on CR, which is the property
 * under test. Asserting that the runner's source contains `\r` would pass
 * against a build that writes it somewhere it never reaches the pty.
 */
/**
 * The stand-in reads a block at a time and submits only on a block that *is* a
 * carriage return, which is the behaviour measured against claude-code 2.1.233.
 *
 * Raw mode first: a pty left canonical has the line discipline translate CR to
 * LF and submit on it, so a stand-in without this accepts either byte and proves
 * nothing. A TUI sets raw and reads the keys itself.
 */
/**
 * Then the block rule. The CLI turns on bracketed paste (`ESC[?2004h`), so a
 * write carrying text and a `\r` together arrives as one paste and the `\r`
 * inside it is content, not Enter. Reading byte by byte here — which the first
 * version did — cannot tell the two apart, and passed against the runner that
 * sent them in one write.
 */
const ON_CR = [
  "import os, sys, tty",
  "tty.setraw(sys.stdin.fileno())",
  "buf = b''",
  "while True:",
  "    chunk = os.read(0, 65536)",
  "    if not chunk: break",
  "    if chunk == b'\\r':",
  "        sys.stdout.write('submitted:' + buf.decode()); sys.stdout.flush(); break",
  "    buf += chunk.replace(b'\\r', b'')",
  "",
].join("\n");

/**
 * A real code's length, and that is the point.
 *
 * The first version of this guard used `WDJB-MJHT` and passed against a runner
 * that put the code and its CR in one `os.write`. Measured against claude-code
 * 2.1.233 in the container: ten characters submitted, ninety-two did not —
 * every asterisk echoed back and then nothing. The CLI turns on bracketed paste
 * (`ESC[?2004h`), so a write that carries text and a `\r` together is one paste,
 * and the `\r` inside it is content. Sent as its own write it is a keypress.
 */
const REAL_LENGTH_CODE = `${"a".repeat(43)}#${"b".repeat(48)}`;

test.skipIf(!python)("a submitted code arrives as Enter, not as a newline", async () => {
  const dir = tempDir("orch-pty-");
  const inbox = join(dir, "code");
  const waiter = join(dir, "on-cr.py");
  writeFileSync(inbox, "");
  writeFileSync(waiter, ON_CR);
  const at = join(dir, basename(PTY_PATH));
  writeFileSync(at, PTY_RUNNER);

  const proc = Bun.spawn([python!, ...PYTHON_FLAGS, at, python!, waiter], {
    env: { ...process.env, ORCH_PTY_IN: inbox },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Exactly what `submit` appends: the shell writes the file with a trailing
  // newline, and turning that into the key press is the runner's job.
  await Bun.sleep(300);
  appendFileSync(inbox, `${REAL_LENGTH_CODE}\n`);

  const out = await Promise.race([new Response(proc.stdout).text(), Bun.sleep(5_000).then(() => "")]);
  proc.kill();
  expect(out).toContain(`submitted:${REAL_LENGTH_CODE}`);
});
