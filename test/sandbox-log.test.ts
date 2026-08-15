import { expect, test } from "bun:test";
import { clearSandboxLog, sandboxLines, sandboxLog } from "../src/mech/sandbox/sandboxlog.ts";
import type { Ctx } from "../src/api.ts";

/**
 * The container's own output, kept long enough to be read.
 *
 * Live frames alone were the whole story, so a boss who opened the panel thirty
 * seconds into a two-minute clone saw an empty box: everything before the panel
 * existed had nowhere to be.
 */

const ctx = (out: string[] = []) =>
  ({ bus: { live: (f: { body: string }) => out.push(f.body) } }) as unknown as Ctx;

test("a line is on the feed and in the buffer, and the buffer is capped", () => {
  clearSandboxLog(1);
  const said: string[] = [];
  const c = ctx(said);
  sandboxLog(c, 1, "cmd", "git clone --progress x /work");
  for (let i = 0; i < 600; i++) sandboxLog(c, 1, "out", `line ${i}`);
  sandboxLog(c, 1, "end", "ok");

  // Everything reaches the live feed; the buffer keeps the tail. `$ ` is what the
  // panes already use to tell a command from its output.
  expect(said[0]).toBe("$ git clone --progress x /work");
  expect(said.length).toBe(602);
  const kept = sandboxLines(1);
  expect(kept.length).toBe(500);
  expect(kept.at(-1)).toMatchObject({ kind: "end", text: "ok" });
  expect(kept.at(-2)).toMatchObject({ kind: "out", text: "line 599" });
});

test("a rebuilt container starts an empty log", () => {
  clearSandboxLog(2);
  sandboxLog(ctx(), 2, "out", "from the container that is now gone");
  expect(sandboxLines(2)).toHaveLength(1);
  clearSandboxLog(2);
  expect(sandboxLines(2)).toEqual([]);
});
