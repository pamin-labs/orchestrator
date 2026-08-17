import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkillsMount, lineQueue, lsofCwd, type Counter } from "../../src/mech/sandbox/sandbox.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { testContext } from "../support/test-context.ts";

/**
 * The bind mount that succeeds and delivers nothing.
 *
 * Measured on this machine: `/var/tmp/orch-cache/skills` holds 179 skills,
 * `docker run -v` on that exact path sees 0, and inside the container the mount
 * shows as an overlay with `lowerdir=/` rather than the host directory. macOS
 * runs docker in a VM and `/var/tmp` there is the VM's, not the Mac's.
 *
 * Nothing errors on that path. `skillMounts` returns two correct mounts,
 * creation succeeds, the degrade path never fires, and preflight reports "179
 * staged" because it counts them on the host — the one place they definitely
 * are. So this count, taken from inside, is the only thing that can tell.
 */

/** A distinct staging directory per test: the check runs once per host path. */
function staged(files: number): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-mount-"));
  for (let i = 0; i < files; i++) {
    mkdirSync(join(dir, `skill-${i}`), { recursive: true });
    writeFileSync(join(dir, `skill-${i}`, "SKILL.md"), "---\nname: x\n---\n");
  }
  return dir;
}

function container(answer: () => string | Promise<never>): Counter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    commands: {
      run: async (cmd) => {
        asked.push(cmd);
        return { logs: { stdout: [{ text: await answer() }] } };
      },
    },
  };
}

const blockers = (ctx: ReturnType<typeof testContext>): string[] =>
  ctx.db
    .query<{ body: string }, []>("SELECT body FROM event WHERE kind = 'state_change'")
    .all()
    .map((r) => r.body);

test("skills on the host and none in the container is called a blocker, with both counts", async () => {
  const ctx = testContext({ db: openMemory() });
  const host = staged(3);
  const sb = container(() => "0\n");

  await checkSkillsMount(ctx, sb, host, "/opt/orch/skills");

  const [said] = blockers(ctx);
  expect(said).toContain(host);
  expect(said).toContain("3");
  expect(said).toContain("/opt/orch/skills");
  // And it names the fix, because the symptom points nowhere near the cause.
  expect(said).toContain("allowed_host_paths");
  // The path is quoted: a staging directory under a home with a space in it is
  // otherwise two arguments to `ls`.
  expect(sb.asked[0]).toBe("ls '/opt/orch/skills' | wc -l");
});

test("a mount that actually carried the skills says nothing", async () => {
  const ctx = testContext({ db: openMemory() });

  await checkSkillsMount(
    ctx,
    container(() => "179\n"),
    staged(3),
    "/opt/orch/skills",
  );

  expect(blockers(ctx)).toEqual([]);
});

test("a boss who has ticked no skills gets no noise", async () => {
  // Nothing staged means `skillMounts` mounted nothing, so an empty directory
  // inside is the correct outcome and not a finding.
  const ctx = testContext({ db: openMemory() });
  const sb = container(() => "0\n");

  await checkSkillsMount(ctx, sb, staged(0), "/opt/orch/skills");

  expect(blockers(ctx)).toEqual([]);
  // And it costs no exec: one `ls` per host path per process is the budget.
  expect(sb.asked).toEqual([]);
});

test("a host path that is not there is not a mount problem", async () => {
  const ctx = testContext({ db: openMemory() });
  const sb = container(() => "0\n");

  await checkSkillsMount(ctx, sb, join(tmpdir(), "orch-mount-never-existed"), "/opt/orch/skills");

  expect(blockers(ctx)).toEqual([]);
  expect(sb.asked).toEqual([]);
});

test("a count that is not a number is not read as zero", async () => {
  // `ls` on a path the container cannot stat prints to stderr and leaves stdout
  // empty. `Number("")` is 0, and reporting that as an empty mount would raise a
  // blocker about a container that simply could not answer.
  const ctx = testContext({ db: openMemory() });

  await checkSkillsMount(
    ctx,
    container(() => "ls: cannot access"),
    staged(2),
    "/opt/orch/skills",
  );

  expect(blockers(ctx)).toEqual([]);
});

test("a container that throws on the count leaves no finding and no exception", async () => {
  // This runs on the create path of every sandbox. A throw here fails the
  // creation over a diagnostic.
  const ctx = testContext({ db: openMemory() });
  const sb: Counter = {
    commands: {
      run: async () => {
        throw new Error("container unavailable");
      },
    },
  };

  await checkSkillsMount(ctx, sb, staged(2), "/opt/orch/skills");

  expect(blockers(ctx)).toEqual([]);
});

test("the same host path is only checked once per process", async () => {
  const ctx = testContext({ db: openMemory() });
  const host = staged(2);
  const sb = container(() => "0\n");

  await checkSkillsMount(ctx, sb, host, "/opt/orch/skills");
  await checkSkillsMount(ctx, sb, host, "/opt/orch/skills");

  expect(sb.asked.length).toBe(1);
  expect(blockers(ctx).length).toBe(1);
});

test("lsof's cwd is read by its field tag, so a path with spaces survives", () => {
  // `-Fn` is tagged output precisely so this is not a column split. A
  // column-counting parse truncates the first cwd that has a space in it.
  expect(lsofCwd("p1234\nfcwd\nn/Users/me/My Code/orch\n")).toBe("/Users/me/My Code/orch");
  // No `n` field at all — a pid that went away between `ps` and `lsof`.
  expect(lsofCwd("p1234\nfcwd\n")).toBeNull();
  expect(lsofCwd("")).toBeNull();
});

/**
 * The bridge between the SDK's callbacks and the turn adapter's `for await`.
 *
 * Both agent CLIs emit NDJSON on stdout and the adapters parse it as it arrives,
 * so the stream has to stay a stream — buffering a whole turn kills the live
 * timeline and, for a long turn, the memory too. Every way this can be wrong is
 * a line that is late, lost, or never delivered at all, and none of them shows
 * up as an error.
 */

/** Collect everything the queue hands over, as its consumer would. */
async function drained(q: ReturnType<typeof lineQueue>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of q.drain()) out.push(l);
  return out;
}

test("lines already waiting when the consumer arrives come out in order", async () => {
  const q = lineQueue();
  q.push(["a", "b"]);
  q.push(["c"]);
  q.end();

  expect(await drained(q)).toEqual(["a", "b", "c"]);
});

test("a line pushed while the consumer is parked is delivered, not lost", async () => {
  // The lost wakeup. The gate has to be re-armed *after* the await, or a line
  // pushed while the consumer was busy resolves a promise nobody is waiting on
  // and the next await parks forever — a live turn that goes silent mid-stream.
  const q = lineQueue();
  const got: string[] = [];

  const consumer = (async () => {
    for await (const l of q.drain()) got.push(l);
  })();

  await Promise.resolve();
  q.push(["first"]);
  await Promise.resolve();
  q.push(["second"]);
  q.end();
  await consumer;

  expect(got).toEqual(["first", "second"]);
});

test("the end does not cut off what was already pushed", async () => {
  // A command that prints its last line and exits in the same tick: the exit
  // handler and the final chunk land together, and honouring the end first
  // drops the line the whole turn was waiting for.
  const q = lineQueue();
  q.push(["last line"]);
  q.end();

  expect(await drained(q)).toEqual(["last line"]);
});

test("a command that printed nothing ends rather than hanging", async () => {
  const q = lineQueue();
  q.end();

  expect(await drained(q)).toEqual([]);
});
