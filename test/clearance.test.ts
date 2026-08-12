import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { allowedToolsFor, buildProfile, writeProfile } from "../src/mech/clearance.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = {
  clearance: "L1" as const,
  worktree: "/tmp/orch/wt/g1",
  repoPath: "/Users/jason/Documents/GitHub/demo",
  siblingWorktrees: ["/tmp/orch/wt/g2"],
};

/** Substring match is enough: these are glob patterns, not exact paths. */
const denies = (list: unknown, needle: string) =>
  (list as string[]).some((p) => p.includes(needle));

test("the sandbox refuses to start rather than degrade silently", () => {
  const p = buildProfile(base).sandbox as Record<string, unknown>;
  // Every misconfiguration in the probe matrix looked exactly like success.
  expect(p.enabled).toBe(true);
  expect(p.failIfUnavailable).toBe(true);
  expect(p.allowUnsandboxedCommands).toBe(false);
});

test("Bash is auto-approved — a headless run cannot prompt", () => {
  const p = buildProfile(base).sandbox as Record<string, unknown>;
  // Without this, every Bash call is denied and the agent invents a workaround
  // instead of asking, which is the failure mode that is hardest to notice.
  expect(p.autoAllowBashIfSandboxed).toBe(true);
});

test("unix sockets stay shut so the docker socket is unreachable", () => {
  const net = (buildProfile(base).sandbox as any).network;
  // allowAllUnixSockets: true reaches /var/run/docker.sock (measured), and
  // filesystem deny rules do not block a socket connect.
  expect(net.allowAllUnixSockets).toBe(false);
  // orch runs over localhost TCP instead; this is what makes that reachable.
  expect(net.allowLocalBinding).toBe(true);
});

test("secrets are unreadable at every clearance", () => {
  for (const clearance of ["L1", "L2"] as const) {
    const fs = (buildProfile({ ...base, clearance }).sandbox as any).filesystem;
    expect(denies(fs.denyRead, ".ssh")).toBe(true);
    expect(denies(fs.denyRead, ".env")).toBe(true);
    expect(denies(fs.denyRead, ".config/gh")).toBe(true);
    expect(denies(fs.denyRead, join(homedir(), ".claude"))).toBe(true);
  }
});

test("writes are denied outside the worktree — the default confines nothing", () => {
  const fs = (buildProfile(base).sandbox as any).filesystem;
  // Measured: with sandbox.enabled alone, a write to a sibling directory
  // succeeds. Confinement exists only because of these entries.
  expect(denies(fs.denyWrite, base.repoPath)).toBe(true);
  expect(denies(fs.denyWrite, "/tmp/orch/wt/g2")).toBe(true);
  expect(denies(fs.denyWrite, "/etc")).toBe(true);
  expect(denies(fs.denyWrite, join(homedir(), "Library"))).toBe(true);
  // …and its own worktree is not in the deny list.
  expect((fs.denyWrite as string[]).some((p) => p === join(base.worktree, "**"))).toBe(false);
});

test("L1 cannot touch dependency or CI config; L2 can", () => {
  const l1 = (buildProfile(base).sandbox as any).filesystem.denyWrite;
  expect(denies(l1, "package.json")).toBe(true);
  expect(denies(l1, ".github")).toBe(true);

  const l2 = (buildProfile({ ...base, clearance: "L2" }).sandbox as any).filesystem.denyWrite;
  expect(denies(l2, "package.json")).toBe(false);
});

test("QA gets no unconstrained Read of the whole repo", () => {
  const qa = allowedToolsFor("qa", "L1");
  // The single largest saving in the plan: a review's information is in the
  // diff, and re-reading a module costs about as much as writing it.
  expect(qa).toContain("Bash(git diff*)");
  expect(qa).not.toContain("Write");
  expect(qa).not.toContain("Edit");

  const eng = allowedToolsFor("engineer", "L1");
  expect(eng).toContain("Edit");
});

test("every role can reach orch and nothing else runs unsandboxed", () => {
  for (const role of ["pm", "engineer", "qa", "dispatcher", "librarian", "architect"]) {
    const tools = allowedToolsFor(role, "L1");
    expect(tools).toContain("Bash(orch *)");
    // A bare `Bash` would let any command through; excludedCommands-style
    // whole-line escapes are exactly what we are avoiding.
    expect(tools).not.toContain("Bash");
  }
});

test("writeProfile emits valid JSON at the path handed to --settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-prof-"));
  const p = writeProfile(dir, "g1-L1", base);
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  expect(parsed.sandbox.enabled).toBe(true);
  expect(p.endsWith("g1-L1.json")).toBe(true);
});
