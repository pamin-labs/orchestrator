import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../src/ctx.ts";
import { imagePaths } from "../src/mech/util/attachment-text.ts";
import { Bus } from "../src/bus.ts";
import { openMemory } from "../src/db.ts";
import { loadConfig, loadRoles } from "../src/platform/config/load.ts";
import { Scheduler } from "../src/scheduler.ts";
import { ATTACH_DIR, stageAttachments, type ExecDeps } from "../src/runtime/executor.ts";
import { fakeSandbox } from "./fake-sandbox.ts";

/**
 * The boss attaches a screenshot and the agent has to be able to open it.
 *
 * `withAttachments` writes the **host** path into the message, and since 005 the
 * turn runs in a container where that path does not exist. claude was told to
 * `Read` a missing file — the tool call failed, the agent improvised, the turn
 * reported success. codex got `-i <host path>` for a file that was not there.
 * Nothing copied them in and nothing said so, so the feature was dead for as long
 * as the container had been the boundary.
 */

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "orch-attach-"));
  mkdirSync(join(dir, "attachments"), { recursive: true });
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  const sandbox = fakeSandbox();
  const cfg = { ...loadConfig(), dataDir: dir };
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    sandbox,
    waiters: new Map(),
    config: cfg,
  };
  const deps: ExecDeps = { ctx, cfg, roles: loadRoles("roles") };
  return { dir, ctx, sandbox, deps };
}

test("an attachment is copied into the sandbox and the prompt points at the copy", async () => {
  const h = harness();
  const host = join(h.dir, "attachments", "20260815-0-shot.png");
  writeFileSync(host, "PNGDATA");

  const prompt = `按图改一下\n\n附件（路径如下）：\n- [图1] ${host} (image)`;
  const out = await stageAttachments(h.deps, { grp: 1 }, prompt, 1);

  const inside = `${ATTACH_DIR}/20260815-0-shot.png`;
  expect(h.sandbox.files.get(inside)).toBe("PNGDATA");
  expect(out).toContain(inside);
  // The host path must be gone, not merely accompanied: whatever is left in the
  // text is what the agent will try to open.
  expect(out).not.toContain(host);
  // codex takes images as `-i` flags, read back off the assembled prompt — so the
  // rewrite has to happen before that, or the flag names a file in the wrong
  // filesystem.
  expect(imagePaths(out)).toEqual([inside]);
});

test("only paths under the attachments directory are touched", async () => {
  const h = harness();
  // An agent's own bullet list, and a boss path pointing somewhere else entirely.
  // Parsing the `附件（路径如下）：` header instead would make both of these
  // candidates for being copied into the container.
  const prompt = `计划：\n- /etc/passwd\n- [注意] /Users/someone/secrets.txt\n- src/api.ts 要改`;
  const out = await stageAttachments(h.deps, { grp: 1 }, prompt, 1);
  expect(out).toBe(prompt);
  expect(h.sandbox.files.size).toBe(0);
});

test("an attachment that cannot be staged is said out loud", async () => {
  const h = harness();
  const missing = join(h.dir, "attachments", "gone.png");
  const prompt = `附件（路径如下）：\n- ${missing} (image)`;
  await stageAttachments(h.deps, { grp: 1 }, prompt, 1);

  const said = h.ctx.db
    .query<{ body: string }, []>("SELECT body FROM event WHERE kind = 'state_change' ORDER BY seq DESC LIMIT 1")
    .get();
  // Silence is what made the original bug survive; a broken attachment has to be
  // a line the boss can see.
  expect(said?.body).toContain("gone.png");
});
