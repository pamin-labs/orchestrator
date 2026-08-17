import { expect, test } from "bun:test";
import { makeApp } from "../src/api.ts";
import type { Ctx } from "../src/mech/ctx.ts";
import type { Json } from "../src/contracts/json.ts";
import { Bus } from "../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../src/platform/config/load.ts";
import { openMemory } from "../src/platform/persistence/database.ts";
import { Scheduler } from "../src/platform/scheduling/scheduler.ts";
import { loadAuth } from "../src/mech/sandbox/auth.ts";
import type { DeviceFlowFetcher } from "../src/mech/git/ghlogin.ts";
import { finishGithubLogin, githubDeviceLogin } from "../src/api/panel/authflow.ts";
import { fakeSandbox } from "./fake-sandbox.ts";

/**
 * Two credential flows, and the one property both of them owe the panel.
 *
 * A login route hands back a link and a code and nothing else. The token the
 * flow produces is written to `runtime_auth` and read back masked; it must never
 * come out of a response, and a failure must carry the reason without carrying
 * the exchange that failed.
 */

const CLAUDE_TOKEN = "sk-ant-oat01-abcdefghijklmnop";

function harness(handle: (cmd: string) => { code?: number; out?: string; err?: string } = () => ({})) {
  const db = openMemory();
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    sandbox: fakeSandbox((cmd) => handle(cmd)),
    waiters: new Map(),
    config: loadConfig(),
  };
  const app = makeApp(ctx);
  const post = (path: string, body?: Json) =>
    app(
      new Request(`http://x${path}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      }),
    );
  return { db, ctx, app, post };
}

/** Reset the one module slot each flow holds, so order between tests cannot matter. */
const reset = async (h: ReturnType<typeof harness>) => {
  await h.post("/api/v1/auth/claude/login/cancel");
};

const said = (h: ReturnType<typeof harness>) =>
  h.db
    .query<{ body: string }, []>("SELECT body FROM event WHERE kind = 'state_change' ORDER BY seq")
    .all()
    .map((r) => r.body);

// -------------------------------------------------------- claude setup-token

test("the claude login hands back the link and nothing else", async () => {
  // The real CLI prints its URL and then the token on a later line. Neither the
  // response nor the panel's own state may carry the second one.
  const h = harness((cmd) =>
    cmd.includes("setup-token")
      ? { code: 0, out: `Open https://claude.ai/oauth/authorize?x=1 to continue\n${CLAUDE_TOKEN}\n` }
      : { code: 0 },
  );
  await reset(h);

  const r = await h.post("/api/v1/auth/claude/login");
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).toContain("https://claude.ai/oauth/authorize?x=1");
  expect(text).not.toContain(CLAUDE_TOKEN);
  expect(text).not.toContain("sk-ant");
  // Stored where a credential belongs, and read back masked from there.
  expect(loadAuth(h.db, "claude")?.secret).toBe(CLAUDE_TOKEN);
  await reset(h);
});

test("a CLI that prints no link is a 422 that says how to check the image", async () => {
  const h = harness(() => ({ code: 1, err: "no pty" }));
  await reset(h);

  const r = await h.post("/api/v1/auth/claude/login");
  expect(r.status).toBe(422);
  const text = await r.text();
  expect(text).toContain("claude setup-token");
  // No credential, and no half-started flow left holding the slot.
  expect(loadAuth(h.db, "claude")).toBeNull();
  expect((await h.post("/api/v1/auth/claude/login/code", { code: "WDJB" })).status).toBe(422);
  await reset(h);
});

test("a code with no login waiting for it is refused, and so is an empty one", async () => {
  const h = harness();
  await reset(h);
  const empty = await h.post("/api/v1/auth/claude/login/code", { code: "   " });
  expect(empty.status).toBe(422);
  expect(await empty.text()).toContain("没有码");

  const orphan = await h.post("/api/v1/auth/claude/login/code", { code: "WDJB-MJHT" });
  expect(orphan.status).toBe(422);
  expect(await orphan.text()).toContain("先点登录");
  await reset(h);
});

// ------------------------------------------------------- github device flow

const DEVICE = {
  device_code: "dev-secret-code",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  interval: "0",
  expires_in: 900,
};

/** GitHub's two endpoints, from a script, counting what it was asked. */
function scripted(answers: Json[]): DeviceFlowFetcher & { calls: () => number } {
  let i = 0;
  const fetchFn = async () => {
    const a = answers[Math.min(i++, answers.length - 1)];
    return { ok: true, status: 200, json: async () => a };
  };
  return Object.assign(fetchFn, { calls: () => i });
}

/** The next thing the panel is told, as a promise, so nothing has to be slept on. */
function nextSaid(h: ReturnType<typeof harness>): Promise<string> {
  return new Promise((resolve) => {
    const off = h.ctx.bus.subscribe((frame) => {
      if (frame.type === "event" && frame.kind === "state_change") {
        off();
        resolve(frame.body ?? "");
      }
    });
  });
}

test("the device flow mints once, reuses a live code, and never returns the one it trades", async () => {
  const h = harness();
  // GitHub refusing to mint is the state the button starts in when the app is
  // misconfigured: a 422 carrying GitHub's own reason, and nothing stored.
  const refused = await githubDeviceLogin(
    h.ctx,
    scripted([{ error: "unauthorized_client", error_description: "this app cannot use the device flow" }]),
  );
  expect(refused.status).toBe(422);
  expect(await refused.text()).toContain("this app cannot use the device flow");
  expect(loadAuth(h.db, "github")).toBeNull();

  const denied = nextSaid(h);
  const first = await githubDeviceLogin(h.ctx, scripted([DEVICE, { error: "access_denied" }]));
  // A second click while that code is still good hands back the same code rather
  // than starting a second poll: two loops racing for one login is two ways to
  // store a token and one of them wins silently.
  const second = scripted([{ error: "should never be asked" }]);
  const again = await githubDeviceLogin(h.ctx, second);
  expect(second.calls()).toBe(0);

  expect(first.status).toBe(200);
  const text = await first.text();
  expect(text).toContain("WDJB-MJHT");
  expect(text).toContain("https://github.com/login/device");
  // `device_code` is the half that trades for a token. It stays on this side.
  expect(text).not.toContain("dev-secret-code");
  expect(again.status).toBe(200);
  expect(await again.text()).toContain("WDJB-MJHT");

  // And the refusal that ends the poll clears the pending code, so the button is
  // pressable again rather than stuck on a code nobody can use.
  expect(await denied).toContain("拒绝了这次授权");
});

test("a poll that lands stores the token, kills the sandboxes and says so without the token", async () => {
  const h = harness();
  h.db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', 'o/p', 0)");
  h.db.run("INSERT INTO grp (project_id, name, status, sandbox_id, created_at) VALUES (1, 'g1', 'PAUSED', 'sb-1', 0)");
  h.db.run(
    "INSERT INTO escalation (grp_id, severity, question, chain_state, created_at) VALUES (1, 'blocker', 'github 的凭据没配', 'boss', 0)",
  );

  await finishGithubLogin(
    h.ctx,
    {
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      deviceCode: "d",
      interval: 0,
      expiresIn: 900,
    },
    scripted([{ access_token: "gho_secret_token" }]),
  );

  expect(loadAuth(h.db, "github")?.secret).toBe("gho_secret_token");
  // The credential that was missing is the credential that was asked about, so
  // the question closes itself rather than sitting on the boss's queue.
  expect(h.db.query<{ answer: string | null }, []>("SELECT answer FROM escalation WHERE id = 1").get()!.answer).toBe(
    "reconfigured",
  );
  const lines = said(h);
  expect(lines).toContain("GitHub 连上了");
  expect(lines.join("\n")).not.toContain("gho_secret_token");
});

test("a poll GitHub denies is reported by reason, not by exchange", async () => {
  const h = harness();
  await finishGithubLogin(
    h.ctx,
    {
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      deviceCode: "dev-secret-code",
      interval: 0,
      expiresIn: 900,
    },
    scripted([{ error: "access_denied" }]),
  );

  expect(loadAuth(h.db, "github")).toBeNull();
  const lines = said(h).join("\n");
  expect(lines).toContain("拒绝了这次授权");
  expect(lines).not.toContain("dev-secret-code");
});
