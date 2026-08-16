import { expect, test } from "bun:test";
import { kvArgs, parseArgs } from "../src/orch/cli.ts";

test("flags, positionals and pass-through are kept separate", () => {
  const p = parseArgs(["mail", "qa", "--intent", "request", "please", "verify"]);
  expect(p.args).toEqual(["mail", "qa", "please", "verify"]);
  expect(p.flags.intent).toBe("request");
});

test("a bare -- passes everything through untouched", () => {
  const p = parseArgs(["git", "--", "commit", "-m", "--not-a-flag"]);
  expect(p.rest).toEqual(["commit", "-m", "--not-a-flag"]);
  expect(p.flags).toEqual({});
});

test("-h asks for help, it is not a question for the boss", () => {
  // `orch ask-boss -h` filed an escalation whose entire text was "-h" and then
  // waited for an answer.
  const p = parseArgs(["ask-boss", "-h"]);
  expect(p.flags.help).toBe(true);
  expect(p.args).toEqual(["ask-boss"]);
  // Still passed through untouched where it is somebody else's flag.
  expect(parseArgs(["git", "--", "log", "-h"]).rest).toEqual(["log", "-h"]);
});

test("valueless flags become true", () => {
  expect(parseArgs(["task", "list", "--json"]).flags.json).toBe(true);
  expect(parseArgs(["x", "--a", "--b", "1"]).flags).toEqual({ a: true, b: "1" });
});

test("repeated flags accumulate instead of overwriting", () => {
  const p = parseArgs(["journal", "add", "--file", "a.ts", "--file", "b.ts"]);
  expect(p.flags.file).toEqual(["a.ts", "b.ts"]);

  // An array, not a newline-joined string. Joining made "two values" and "one
  // value with a newline in it" the same thing on the way back out, and the
  // second is one line away: `orch pr --body "$(cat msg.txt)"`.
  const body = parseArgs(["pr", "--body", "first line\nsecond line"]);
  expect(body.flags.body).toBe("first line\nsecond line");
});

test("--arg k=v pairs parse, and a value containing = survives", () => {
  const p = parseArgs(["lease", "build", "--arg", "target=release", "--arg", "flags=-O2 -g"]);
  expect(kvArgs(p.flags.arg)).toEqual({ target: "release", flags: "-O2 -g" });
  expect(kvArgs(parseArgs(["x", "--arg", "q=a=b"]).flags.arg)).toEqual({ q: "a=b" });
});

test("malformed --arg entries are dropped rather than sent as junk", () => {
  expect(kvArgs(parseArgs(["x", "--arg", "novalue"]).flags.arg)).toEqual({});
  expect(kvArgs(undefined)).toEqual({});
});
