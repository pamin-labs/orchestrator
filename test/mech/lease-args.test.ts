import { describe, expect, test } from "bun:test";
import {
  digestOutput,
  LeaseArgsSchema,
  resolveLease,
  tokenize,
  type ResourceDef,
  runResource,
  LEASE_TIMEOUT_CODE,
  loadResource,
} from "../../src/mech/lease.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import * as fx from "../support/factories.ts";

describe("lease arguments are flat JSON scalars before resource-specific validation", () => {
  test.each([
    [{ target: "release", jobs: 8, clean: false }, true],
    [null, false],
    [{ target: null }, false],
    [{ target: ["release"] }, false],
    [{ target: { name: "release" } }, false],
  ])("%j parses: %p", (args, accepted) => {
    expect(LeaseArgsSchema.safeParse(args).success).toBe(accepted);
  });
});

const testRes: ResourceDef = {
  name: "test",
  template: "bun test {file}",
  concurrency: 1,
  argSchema: { file: { type: "path", root: "/tmp/wt/g1" } },
  errorRegex: "^(error|FAIL|\\s+at )",
};

const buildRes: ResourceDef = {
  name: "build",
  template: "make {target} -j{jobs}",
  concurrency: 1,
  argSchema: {
    target: { type: "enum", values: ["debug", "release"] },
    jobs: { type: "int", min: 1, max: 8 },
  },
};

test("tokenize splits on whitespace and honours quotes", () => {
  expect(tokenize("bun test {file}")).toEqual(["bun", "test", "{file}"]);
  expect(tokenize(`sh -c "echo hi there"`)).toEqual(["sh", "-c", "echo hi there"]);
  expect(tokenize("  a   b  ")).toEqual(["a", "b"]);
  expect(tokenize(`x ""`)).toEqual(["x", ""]);
});

test("a valid lease resolves to argv, never to a shell string", () => {
  const r = resolveLease(testRes, { file: "test/mw.test.ts" });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.argv).toEqual(["bun", "test", "/tmp/wt/g1/test/mw.test.ts"]);
});

test("shell metacharacters in an arg are inert, not filtered", () => {
  // Injection is structurally impossible: argv is spawned without a shell, so
  // this arg can only ever be one filename-shaped token.
  const r = resolveLease(buildRes, { target: "debug", jobs: 4 });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.argv).toEqual(["make", "debug", "-j4"]);

  const bad = resolveLease(buildRes, { target: "debug; rm -rf ~", jobs: 4 });
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error).toContain("one of");
});

test("free-form commands cannot be smuggled in as an extra arg", () => {
  const r = resolveLease(testRes, { file: "test/a.ts", cmd: "rm -rf /" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("unused args");
});

describe("path args cannot escape their root", () => {
  test.each(["../../etc/passwd", "/etc/passwd", "test/../../..", ".."])("%s is refused", (path) => {
    const r = resolveLease(testRes, { file: path });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("inside");
  });
});

test("a null byte in a path is rejected", () => {
  const r = resolveLease(testRes, { file: "test/a\0.ts" });
  expect(r.ok).toBe(false);
});

test("missing args and undeclared placeholders both fail loudly", () => {
  expect(resolveLease(testRes, {}).ok).toBe(false);
  const undeclared: ResourceDef = { ...testRes, template: "bun test {nope}" };
  const r = resolveLease(undeclared, { nope: "x" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("no schema declares it");
});

describe("int bounds and enum membership are enforced", () => {
  test.each([
    ["above the maximum", { target: "debug", jobs: 99 }],
    ["below the minimum", { target: "debug", jobs: 0 }],
    ["not an integer", { target: "debug", jobs: 1.5 }],
    ["a target outside the enum", { target: "prod", jobs: 2 }],
  ])("%s is refused", (_case, args) => {
    expect(resolveLease(buildRes, args).ok).toBe(false);
  });
});

test("string args need a pattern and honour maxLength", () => {
  const def: ResourceDef = {
    name: "grep",
    template: "rg {pat}",
    concurrency: 1,
    argSchema: { pat: { type: "string", pattern: "^[\\w.-]+$", maxLength: 40 } },
  };
  const accepted = (pat: string) => resolveLease(def, { pat }).ok;
  expect({ matching: accepted("auth_token"), spaced: accepted("a b"), overlong: accepted("x".repeat(41)) }).toEqual({
    matching: true,
    spaced: false,
    overlong: false,
  });
});

test("a placeholder embedded in a token substitutes in place", () => {
  const r = resolveLease(buildRes, { target: "release", jobs: 8 });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.argv[2]).toBe("-j8");
});

test("digest returns exactly three parts and keeps the log off-context", () => {
  const output = [
    ...Array.from({ length: 500 }, (_, i) => `line ${i}`),
    "error: token check missing",
    "FAIL test/mw.test.ts",
  ].join("\n");
  const d = digestOutput(1, output, testRes.errorRegex, "/leases/12.log");

  expect(d.exitCode).toBe(1);
  expect(d.tail.length).toBe(200);
  expect(d.truncated).toBe(true);
  expect(d.errorLines).toEqual(["error: token check missing", "FAIL test/mw.test.ts"]);
  expect(d.text).toContain("exit 1");
  expect(d.text).toContain("## errors (2)");
  expect(d.text).toContain("## tail (200 of 502 lines)");
  expect(d.text).toContain("orch lease log");
  // The whole point: a multi-megabyte log must not come back inline.
  expect(d.text.split("\n").length).toBeLessThan(260);
});

test("digest dedupes repeated error lines and caps them", () => {
  const output = Array.from({ length: 100 }, () => "error: same thing").join("\n");
  const d = digestOutput(2, output, "^error");
  expect(d.errorLines).toEqual(["error: same thing"]);
});

test("a clean short run needs no truncation notice", () => {
  const d = digestOutput(0, "all good\n2 pass\n", "^error");
  expect(d.truncated).toBe(false);
  expect(d.errorLines).toEqual([]);
  expect(d.text).not.toContain("## errors");
  expect(d.text).not.toContain("orch lease log");
});

test("a hung command is killed and says so, instead of holding the slot forever", async () => {
  // Lease slots are global and few, so one command that never returns stops every
  // group from ever gating again. That failure is silent: the queue looks healthy.
  const def = {
    name: "hang",
    template: "sleep 30",
    concurrency: 1,
    argSchema: {},
  };
  // The exec API enforces the wall clock server-side and reports 124, the same
  // number `timeout(1)` has always used; what is checked here is that the digest
  // says something the agent can act on rather than "exit 124".
  const out = await runResource(
    def,
    {},
    {
      timeoutMs: 400,
      exec: async () => ({ code: LEASE_TIMEOUT_CODE, out: "" }),
    },
  );
  expect("digest" in out).toBe(true);
  if (!("digest" in out)) return;
  expect(out.exitCode).toBe(LEASE_TIMEOUT_CODE);
  expect(out.digest.text).toContain("lease timeout");
  // The number has to be actionable: it names the limit it blew through.
  expect(out.digest.text).toContain("min");
});

test("a command that finishes in time is untouched by the timeout", async () => {
  const out = await runResource(
    { name: "ok", template: "echo hi", concurrency: 1, argSchema: {} },
    {},
    {
      timeoutMs: 10_000,
      exec: async () => ({ code: 0, out: "hi" }),
    },
  );
  expect("digest" in out && out.exitCode).toBe(0);
});

test("coercion and refusal are one decision, which they were not", () => {
  // The hand-written `int` case ran `Number(raw)` and asked whether the result
  // was an integer. `Number(" 3 ")` is 3, `Number("")` is 0 and `Number(true)`
  // is 1 — so a blank field and a checkbox both arrived on a command line as
  // numbers somebody chose. zod's `coerce.number().int()` refuses all three.
  const def = {
    name: "build",
    template: "make -j{jobs}",
    concurrency: 1,
    argSchema: { jobs: { type: "int" as const, min: 1, max: 64 } },
  };
  expect(resolveLease(def, { jobs: 4 })).toMatchObject({ ok: true, argv: ["make", "-j4"] });
  expect(resolveLease(def, { jobs: "4" })).toMatchObject({ ok: true, argv: ["make", "-j4"] });
  for (const bad of [true, "", " ", "4x", 4.5, 0, 65]) {
    expect(resolveLease(def, { jobs: bad })).toMatchObject({ ok: false });
  }

  // Same shape on `bool`. `z.coerce.boolean()` would take "false" and "no" as
  // true, which is why this is a union of the two words rather than a coercion.
  const flag = {
    name: "t",
    template: "run --clean={clean}",
    concurrency: 1,
    argSchema: { clean: { type: "bool" as const } },
  };
  expect(resolveLease(flag, { clean: false })).toMatchObject({ ok: true, argv: ["run", "--clean=false"] });
  expect(resolveLease(flag, { clean: "false" })).toMatchObject({ ok: true, argv: ["run", "--clean=false"] });
  expect(resolveLease(flag, { clean: "no" })).toMatchObject({ ok: false });
  expect(resolveLease(flag, { clean: 1 })).toMatchObject({ ok: false });
});

test("the refusal still says what to write instead", () => {
  // An agent reads this and has to correct itself from it. "Invalid option" does
  // not do that, so every message survived the move onto zod verbatim.
  const def = {
    name: "t",
    template: "run {mode}",
    concurrency: 1,
    argSchema: { mode: { type: "enum" as const, values: ["fast", "full"] } },
  };
  const r = resolveLease(def, { mode: "quick" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("mode must be one of: fast, full");
});

/**
 * A resource row read out of the database, including when the row is broken.
 *
 * Three files used to read this and disagreed about what a broken `arg_schema_json`
 * means — two defaulted to `{}` and the third parsed it unguarded, which is the one
 * `POST /orch/v1/lease` reaches: a malformed row threw out of the handler and became
 * a 500 with a JSON syntax error in it.
 */
/**
 * `{}` is the safe end and the reason is structural: an empty schema is a boundary
 * that refuses every argument, so a corrupt row makes the resource unusable rather
 * than unguarded. Mutation put the fallback to a permissive schema and nothing
 * failed — `loadResource` had no test at all.
 */
test("a resource whose schema column is corrupt refuses every argument", () => {
  const db = openMemory();
  fx.resource.insert(db, {
    name: "gate",
    template: "bun run {target}",
    arg_schema_json: "{ this is not json",
  });

  const def = loadResource(db, "gate")!;
  expect(def.argSchema).toEqual({});
  // An empty schema means no argument is declared, so any argument is unknown.
  expect(resolveLease(def, { target: "release" }).ok).toBe(false);
  // And the resource is still *loadable*: refusing to read it would take the whole
  // lease endpoint down for one bad row rather than one resource.
  expect(def.template).toBe("bun run {target}");
});

/**
 * A row that is not there is `null`, not a throw.
 *
 * An agent naming a resource that does not exist is an ordinary mistake — the agent
 * reads the refusal and picks another — and the caller turns this into that message.
 */
test("an unknown resource is absent rather than an error", () => {
  expect(loadResource(openMemory(), "nope")).toBeNull();
});

/**
 * The optional columns are absent rather than null when unset.
 *
 * `errorRegex` and `cwd` are spread conditionally, so a resource that sets neither
 * has neither key — a `cwd: null` reaching the runner would be a directory named
 * "null" rather than the default.
 */
test("unset optional columns do not become null values", () => {
  const db = openMemory();
  fx.resource.insert(db, { name: "plain", template: "true", arg_schema_json: "{}" });
  const def = loadResource(db, "plain")!;
  expect("cwd" in def).toBe(false);
  expect("errorRegex" in def).toBe(false);
  expect(def.tags).toEqual([]);
});
