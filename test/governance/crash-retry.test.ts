import { expect, test } from "bun:test";
import { CRASHED } from "../../scripts/test.ts";

/**
 * The retry fires on a crash and on nothing else.
 *
 * Quoted from a real panic, because a pattern written against remembered text is
 * a retry that never happens — the same mistake as classifying the egress sidecar
 * failure by the Docker message the client never receives.
 */

const PANIC = `
============================================================
Bun v1.3.14 (0d9b296a) macOS Silicon
panic(main thread): Segmentation fault at address 0x6C38377464756519
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
✗ test/web/telemetry-model.test.ts (worker crashed: SIGTRAP)
error: a test worker process crashed with SIGTRAP while running test/web/telemetry-model.test.ts.
`;

test("a worker panic is recognised, and an ordinary failure is not", () => {
  expect(CRASHED.test(PANIC)).toBe(true);

  // A failing test must never be re-run: that is how a flake becomes permanent.
  expect(CRASHED.test("(fail) the gate refuses an unowned file [12.00ms]\n 1 fail\nRan 1706 tests")).toBe(false);
  expect(CRASHED.test("error: expect(received).toBe(expected)")).toBe(false);
  // Nor a test whose own subject is the word.
  expect(CRASHED.test("(pass) a crashed container is reported, not swallowed")).toBe(false);
});
