import type { DB } from "../../src/platform/persistence/database.ts";
import { saveAuth } from "../../src/mech/sandbox/auth.ts";

/**
 * A fleet with no credential configured does not dispatch — that is the point of
 * the check in the scheduler, and it is why every harness that expects turns to
 * run has to say it has one. Cheaper than each test discovering it as "the queue
 * mysteriously does not move".
 */
export async function seedAuth(db: DB): Promise<void> {
  // Awaited, and sequentially: both writes were floating promises under a `void`
  // return, so every harness that seeded and then drained was racing the rows it
  // depends on — green whenever the microtask happened to win.
  await saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: "sk-ant-oat01-test" });
  await saveAuth(db, { runtime: "codex", mode: "api_key", secret: "sk-test" });
}
