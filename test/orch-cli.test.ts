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

test("valueless flags become true", () => {
  expect(parseArgs(["task", "list", "--json"]).flags.json).toBe(true);
  expect(parseArgs(["x", "--a", "--b", "1"]).flags).toEqual({ a: true, b: "1" });
});

test("repeated flags accumulate instead of overwriting", () => {
  const p = parseArgs(["journal", "add", "--file", "a.ts", "--file", "b.ts"]);
  expect(p.flags.file).toBe("a.ts\nb.ts");
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
