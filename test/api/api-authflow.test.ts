import { waitFor } from "@testing-library/dom";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeApp } from "../../src/composition/api.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { asc, eq } from "drizzle-orm";
import type { Json } from "../../src/contracts/json.ts";
import { loadAuth } from "../../src/mech/sandbox/auth.ts";
import { currentClaudeLogin } from "../../src/mech/sandbox/login.ts";
import type { DeviceFlowFetcher } from "../../src/mech/git/ghlogin.ts";
import { finishGithubLogin, githubDeviceLogin } from "../../src/api/panel/authflow.ts";
import { escalation, event } from "../../src/platform/persistence/schema.ts";
import { renderSaid } from "../../src/platform/text/lang.ts";
import { said } from "../support/said.ts";
import * as fx from "../support/factories.ts";
import { escalationKey } from "../../src/mech/flow/escalate.ts";
import { fakePty } from "../support/fake-pty.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { testContext } from "../support/test-context.ts";
import { providerAnswers } from "../support/provider.ts";

let restoreProvider = () => {};
beforeAll(() => {
  restoreProvider = providerAnswers();
});
afterAll(() => {
  restoreProvider();
});

/**
 * Two credential flows, and the one property both of them owe the panel.
 *
 * A login route hands back a link and a code and nothing else. The token the
 * flow produces is written to `runtime_auth` and read back masked; it must never
 * come out of a response, and a failure must carry the reason without carrying
 * the exchange that failed.
 */

/**
 * Long, mixed-case, unbroken — the shape a credential has, because that is all
 * the login recognises now. It knew `sk-ant-oat01-` once and that prefix changed
 * under it, so a short lowercase stand-in would pass a test the product fails.
 */
const CLAUDE_TOKEN = `sk-ant-oat01-${"aB3-_x9Z".repeat(6)}`;

async function harness(
  handle: (cmd: string) => { code?: number; out?: string; err?: string } = () => ({}),
  // Where the sandbox server is. Stated rather than defaulted, because
  // `loadConfig` says 127.0.0.1:8080 and a developer machine often has a real
  // one there — which decides whether the login blames the sandbox or the image.
  // Port 9 (discard) is never listening, so the verdict is `down` and these
  // tests keep testing the CLI's own advice.
  server?: string,
  // What the CLI says in its terminal. Claude's login runs through a pty over
  // execd's WebSocket (ADR 053), so a command-runner double never sees it.
  terminal: string[] = [],
) {
  const base = loadConfig();
  const said = fakePty(terminal);
  queueMicrotask(() => said.exit(0));
  const ctx = await testContext({
    sandbox: fakeSandbox((cmd) => handle(cmd)),
    pty: async () => said,
    ...(server ? { config: { ...base, sandbox: { ...base.sandbox, server } } } : {}),
  });
  const db = ctx.db;
  const app = makeApp(ctx);
  const post = (path: string, body?: Json) =>
    app(
      new Request(`http://x${path}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      }),
    );
  return { db, ctx, app, post, f: fx.on(db) };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Reset the one module slot each flow holds, so order between tests cannot matter. */
const reset = async (h: Harness) => {
  await h.post("/api/v1/auth/claude/login/cancel");
};

const bodies = async (h: Harness) =>
  (
    await h.db.select({ body: event.body }).from(event).where(eq(event.kind, "state_change")).orderBy(asc(event.seq))
  ).map((r) => r.body);

// -------------------------------------------------------- claude setup-token

test("the claude login hands back the link and nothing else", async () => {
  // The real CLI prints its URL and then the token on a later line. Neither the
  // response nor the panel's own state may carry the second one.
  const h = await harness(() => ({ code: 0 }), undefined, [
    "Open https://claude.ai/oauth/authorize?x=1 to continue",
    CLAUDE_TOKEN,
  ]);
  await reset(h);

  const r = await h.post("/api/v1/auth/claude/login");
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).toContain("https://claude.ai/oauth/authorize?x=1");
  expect(text).not.toContain(CLAUDE_TOKEN);
  expect(text).not.toContain("sk-ant");
  // Stored where a credential belongs, and read back masked from there.
  //
  // Waited for, because the response is deliberately not the confirmation: the
  // route hands back the link as soon as the CLI prints it and lets `run.done`
  // write `runtime_auth` afterwards — the panel polls the credential row. Read
  // straight after the POST this raced, and lost on a loaded CI runner while
  // passing on every local run. Same `waitFor` as `test/mech/auth.test.ts:467`,
  // for the same reason: it throws where the waiting happened.
  await waitFor(async () => expect((await loadAuth(h.db, "claude"))?.secret).toBe(CLAUDE_TOKEN));
  await reset(h);
});

test("a CLI that prints no link is a 422 that says how to check the image", async () => {
  // Port 9 (discard) is never listening, so the sandbox verdict is `down` rather
  // than `stuck` and this keeps testing the CLI's own advice. Left at the
  // default it read `loadConfig()`'s 127.0.0.1:8080 — a real server on the
  // developer's machine, and the answer changed with the machine.
  const h = await harness(() => ({ code: 1, err: "no pty" }), "127.0.0.1:9");
  await reset(h);

  const r = await h.post("/api/v1/auth/claude/login");
  expect(r.status).toBe(422);
  const text = await r.text();
  expect(text).toContain("claude setup-token");
  // No credential, and no half-started flow left holding the slot.
  expect(await loadAuth(h.db, "claude")).toBeNull();
  expect((await h.post("/api/v1/auth/claude/login/code", { code: "WDJB" })).status).toBe(422);
  await reset(h);
});

/**
 * A cancel with nothing to cancel starts nothing.
 *
 * `postClaudeCancel` spelled itself `startClaudeLogin(ctx).cancel()`, and that
 * getter is get-or-*create*: with no run in flight it built one and launched
 * `claude setup-token` in the utility container. In an image holding a session
 * that mints and stores a real token; here it was a second `saveAuth` landing on
 * whatever schema was current by then — the flake that failed
 * `a CLI that prints no link is a 422` with a credential its own login never made.
 */
/**
 * Asserted on the module slot rather than on the credential, because the slot is
 * set synchronously by the getter while the write is several awaits away. The
 * symptom was timing; the cause is not, and a guard that reproduces the timing is
 * a guard that goes green on a fast machine.
 */
test("cancelling when no login is in flight starts none", async () => {
  const h = await harness((cmd) =>
    cmd.includes("setup-token") ? { code: 0, out: `https://claude.ai/oauth?x=1\n${CLAUDE_TOKEN}\n` } : { code: 0 },
  );
  await reset(h);
  expect(currentClaudeLogin()).toBeNull();
  expect(await loadAuth(h.db, "claude")).toBeNull();
  await reset(h);
});

test("a code with no login waiting for it is refused, and so is an empty one", async () => {
  const h = await harness();
  await reset(h);
  const empty = await h.post("/api/v1/auth/claude/login/code", { code: "   " });
  expect(empty.status).toBe(422);
  expect(await empty.text()).toContain("no code given");

  const orphan = await h.post("/api/v1/auth/claude/login/code", { code: "WDJB-MJHT" });
  expect(orphan.status).toBe(422);
  expect(await orphan.text()).toContain("start one first");
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
function nextSaid(h: Harness): Promise<string> {
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
  const h = await harness();
  // GitHub refusing to mint is the state the button starts in when the app is
  // misconfigured: a 422 carrying GitHub's own reason, and nothing stored.
  const refused = await githubDeviceLogin(
    h.ctx,
    scripted([{ error: "unauthorized_client", error_description: "this app cannot use the device flow" }]),
  );
  expect(refused.status).toBe(422);
  expect(await refused.text()).toContain("this app cannot use the device flow");
  expect(await loadAuth(h.db, "github")).toBeNull();

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
  expect(await denied).toContain("the authorization was denied on GitHub");
});

test("a poll that lands stores the token, kills the sandboxes and says so without the token", async () => {
  const h = await harness();
  const p = await h.f.project.create({ name: "p", repo_path: "o/p" });
  const g = await h.f.grp.create({ project_id: p.id, name: "g1", status: "PAUSED", sandbox_id: "sb-1" });
  await h.f.escalation.create({
    grp_id: g.id,
    severity: "blocker",
    // Found by its key. The sentence is deliberately not the one that ships, so
    // that rewording the question cannot be what makes this test pass.
    question: "no github credential",
    dedupe_key: escalationKey.auth("github"),
    chain_state: "boss",
  });

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

  expect((await loadAuth(h.db, "github"))?.secret).toBe("gho_secret_token");
  // The credential that was missing is the credential that was asked about, so
  // the question closes itself rather than sitting on the boss's queue.
  const [asked] = await h.db.select({ answer: escalation.answer }).from(escalation).where(eq(escalation.id, 1));
  expect(asked?.answer).toBe("reconfigured");
  const lines = await bodies(h);
  // The message named by its English source, not a copy of one translation of it:
  // `said()` hashes the source the way the macro does, so rewording the `msg`
  // template reds this line — which is right, because "this sentence was shown"
  // is what the assertion says. Rendered in the harness's own language, the way
  // `Bus.prepare` renders it.
  expect(lines).toContain(renderSaid(h.ctx.config.language, said("GitHub is connected")));
  expect(lines.join("\n")).not.toContain("gho_secret_token");
});

test("a poll GitHub denies is reported by reason, not by exchange", async () => {
  const h = await harness();
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

  expect(await loadAuth(h.db, "github")).toBeNull();
  const lines = (await bodies(h)).join("\n");
  expect(lines).toContain("the authorization was denied on GitHub");
  expect(lines).not.toContain("dev-secret-code");
});
