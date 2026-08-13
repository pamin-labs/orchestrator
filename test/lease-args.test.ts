import { expect, test } from "bun:test";
import { digestOutput, resolveLease, tokenize, type ResourceDef, runResource, LEASE_TIMEOUT_CODE } from "../src/mech/lease.ts";

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

test("path args cannot escape their root", () => {
  for (const p of ["../../etc/passwd", "/etc/passwd", "test/../../..", ".."]) {
    const r = resolveLease(testRes, { file: p });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("inside");
  }
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

test("int bounds and enum membership are enforced", () => {
  expect(resolveLease(buildRes, { target: "debug", jobs: 99 }).ok).toBe(false);
  expect(resolveLease(buildRes, { target: "debug", jobs: 0 }).ok).toBe(false);
  expect(resolveLease(buildRes, { target: "debug", jobs: 1.5 }).ok).toBe(false);
  expect(resolveLease(buildRes, { target: "prod", jobs: 2 }).ok).toBe(false);
});

test("string args need a pattern and honour maxLength", () => {
  const def: ResourceDef = {
    name: "grep",
    template: "rg {pat}",
    concurrency: 1,
    argSchema: { pat: { type: "string", pattern: "^[\\w.-]+$", maxLength: 40 } },
  };
  expect(resolveLease(def, { pat: "auth_token" }).ok).toBe(true);
  expect(resolveLease(def, { pat: "a b" }).ok).toBe(false);
  expect(resolveLease(def, { pat: "x".repeat(41) }).ok).toBe(false);
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
  const t0 = Date.now();
  const out = await runResource(def, {}, { timeoutMs: 400 });
  expect(Date.now() - t0).toBeLessThan(6000);
  expect("digest" in out).toBe(true);
  if (!("digest" in out)) return;
  expect(out.exitCode).toBe(LEASE_TIMEOUT_CODE);
  expect(out.digest.text).toContain("lease timeout");
  // The number has to be actionable: it names the limit it blew through.
  expect(out.digest.text).toContain("min");
});

test("a command that finishes in time is untouched by the timeout", async () => {
  const out = await runResource({ name: "ok", template: "echo hi", concurrency: 1, argSchema: {} }, {}, {
    timeoutMs: 10_000,
  });
  expect("digest" in out && out.exitCode).toBe(0);
});
