import type { DB } from "../../src/platform/persistence/database.ts";
import { saveAuth } from "../../src/mech/sandbox/auth.ts";

/**
 * A fleet with no credential configured does not dispatch — that is the point of
 * the check in the scheduler, and it is why every harness that expects turns to
 * run has to say it has one. Cheaper than each test discovering it as "the queue
 * mysteriously does not move".
 */
export function seedAuth(db: DB): void {
  saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: "sk-ant-oat01-test" });
  saveAuth(db, { runtime: "codex", mode: "api_key", secret: "sk-test" });
}
