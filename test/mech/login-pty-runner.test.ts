import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
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
