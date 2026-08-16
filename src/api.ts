import { Hono } from "hono";
import type { Caller, Ctx } from "./ctx.ts";
import { agentOf, mayAct, mintToken, resolveGroup, text, type AgentHandler, type Handler } from "./api/shared.ts";
import { getAuth, getGithubLogin, getGithubRepos, postAuth, postClaudeCancel, postClaudeCode, postClaudeLogin, postCodexDevice, postCodexDeviceCancel, postGithubLogin, postTrailers } from "./api/authflow.ts";
import { bossFact, expandHome, getAttachment, imagePaths, postAttach, postAttachLocal, withAttachments, type Attachment } from "./api/attach.ts";
import { CTX_BUDGET_CHARS, postCtxQuery } from "./api/ctxquery.ts";
import { ASK_KINDS, askKind, brief, getAnswerDraft, postAnswer, postAnswer2, postAskBoss, postDelegate, postEscalationRequirement, postRevoke, postTriage } from "./api/escalation.ts";
import { landGroup, postDraftDecision, postGroupControl, postIdea } from "./api/group.ts";
import { getLeaseLog, postLease } from "./api/lease.ts";
import { postMail, postSay } from "./api/messaging.ts";
import { getDirs, getNotes, getSkills, postSkill } from "./api/panel.ts";
import { postBlocked, postDraft, postDrop, postOwns, postSplit } from "./api/planning.ts";
import { postPr } from "./api/pr.ts";
import { deleteProject, getProjectConfig, patchProjectConfig, postProject, postSetup } from "./api/project.ts";
import { evictOldestLessons, LESSON_CAP, postJournal, postStatus } from "./api/report.ts";
import { getEvidence, getGateLog, postAudit, postReview, postSliceDecision } from "./api/review.ts";
import { getSettings, postSetting } from "./api/settings.ts";
import { getImages, getPreflight, getSandbox, getSandboxServer, postImage, postSandboxServerAddr, postSandboxServerRestart, postSandboxServerStart } from "./api/sandbox.ts";
import { getCost, getState, snapshot } from "./api/snapshot.ts";
import { getStream } from "./api/stream.ts";
import { getTasks, postTaskClaim, postTaskDone } from "./api/tasks.ts";

/**
 * One API, two clients: the web UI (the boss's main surface) and `orch` (what
 * agents call over Bash). Anything the web can do has an `orch` verb and vice
 * versa — there is deliberately no second implementation anywhere.
 *
 * This file is the wiring: which module owns which path, the two checks that
 * run ahead of every route, and nothing else. The verbs live in `./api/*`, one
 * file per subject.
 */

/**
 * The public face of the route layer.
 *
 * Everything here is imported from outside the routes — by `server.ts`, by the
 * executor, by the answer chain, or by a test. It is re-exported rather than
 * moved so that splitting this file cost its callers nothing.
 */
export type { Caller, Ctx };
export { agentOf, mayAct, mintToken, resolveGroup };
export { bossFact, expandHome, imagePaths, withAttachments, type Attachment };
export { ASK_KINDS, askKind, brief };
export { CTX_BUDGET_CHARS, evictOldestLessons, landGroup, LESSON_CAP, snapshot };

const ROUTES: Array<[string, RegExp, Handler]> = [
  ["GET", /^\/api\/auth$/, getAuth],
  ["POST", /^\/api\/auth$/, postAuth],
  ["POST", /^\/api\/auth\/claude\/login$/, postClaudeLogin],
  ["POST", /^\/api\/auth\/claude\/login\/code$/, postClaudeCode],
  ["POST", /^\/api\/auth\/claude\/login\/cancel$/, postClaudeCancel],
  ["GET", /^\/api\/auth\/github$/, getGithubLogin],
  ["GET", /^\/api\/github\/repos$/, getGithubRepos],
  ["POST", /^\/api\/auth\/github$/, postGithubLogin],
  ["POST", /^\/api\/git\/trailers$/, postTrailers],
  ["POST", /^\/api\/auth\/codex\/device$/, postCodexDevice],
  ["POST", /^\/api\/auth\/codex\/device\/cancel$/, postCodexDeviceCancel],
  ["GET", /^\/api\/preflight$/, getPreflight],
  ["GET", /^\/api\/sandbox\/images$/, getImages],
  ["POST", /^\/api\/sandbox\/images$/, postImage],
  ["GET", /^\/api\/sandbox-server$/, getSandboxServer],
  ["POST", /^\/api\/sandbox-server\/restart$/, postSandboxServerRestart],
  ["POST", /^\/api\/sandbox-server\/start$/, postSandboxServerStart],
  ["POST", /^\/api\/sandbox-server\/addr$/, postSandboxServerAddr],
  ["GET", /^\/api\/sandbox$/, getSandbox],
  ["GET", /^\/api\/project\/(?<id>\d+)\/config$/, getProjectConfig],
  ["POST", /^\/api\/project\/(?<id>\d+)\/config$/, patchProjectConfig],

  ["GET", /^\/api\/settings$/, getSettings],
  ["POST", /^\/api\/settings$/, postSetting],
  ["GET", /^\/api\/state$/, getState],
  ["GET", /^\/api\/cost$/, getCost],
  ["GET", /^\/api\/stream$/, getStream],
  ["GET", /^\/api\/dirs$/, getDirs],
  ["GET", /^\/api\/notes$/, getNotes],
  ["GET", /^\/api\/skills$/, getSkills],
  ["POST", /^\/api\/skills$/, postSkill],
  ["POST", /^\/api\/projects$/, postProject],
  ["DELETE", /^\/api\/projects\/(?<id>\d+)$/, deleteProject],
  ["POST", /^\/api\/ideas$/, postIdea],
  ["POST", /^\/api\/attach$/, postAttach],
  ["POST", /^\/api\/attach\/local$/, postAttachLocal],
  ["POST", /^\/api\/say$/, postSay],
  ["POST", /^\/api\/draft\/(?<id>\d+)\/(?<decision>approve|reject)$/, postDraftDecision],
  // No `landed`: whether a PR is merged is GitHub's answer, and `pollPrs` asks it
  // every tick. A button for it was a boss confirming by hand what the server
  // already knew — and one mis-click dissolved a group whose PR was still open.
  ["POST", /^\/api\/groups\/(?<id>\d+)\/(?<action>pause|resume|park|wake|interrupt|budget|drop|newpr|rebuild)$/, postGroupControl],
  ["GET", /^\/api\/slices\/(?<id>\d+)\/evidence$/, getEvidence],
  ["GET", /^\/api\/slices\/(?<id>\d+)\/gate\/(?<name>[\w.-]+)$/, getGateLog],
  ["POST", /^\/api\/slices\/(?<id>\d+)\/(?<decision>accept|reject)$/, postSliceDecision],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/answer$/, postAnswer],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/revoke$/, postRevoke],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/requirement$/, postEscalationRequirement],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/delegate$/, postDelegate],
  ["GET", /^\/api\/escalations\/(?<id>\d+)\/draft$/, getAnswerDraft],
  ["GET", /^\/api\/attach\/(?<name>[^/]+)$/, getAttachment],
];

/**
 * Is this write coming from somewhere other than the panel?
 *
 * `/api/*` takes no token — its caller is a browser on 127.0.0.1 and the port is
 * the whole authentication story. That stops the network and does not stop a web
 * page: `body<T>()` never checks `content-type`, so a POST with the default
 * `text/plain` is a *simple* request, no preflight, delivered. The attacker
 * cannot read the reply and does not need to — wiping the boss's credentials,
 * approving a DRAFT and dropping a group are all one-way.
 *
 * A deny-list, not an allow-list, because the legitimate non-browser callers —
 * `curl`, `bun test`, the mailbox replay — send neither header, and refusing
 * those would be refusing everything except the panel. Every browser that can
 * mount this attack sends `Sec-Fetch-Site`.
 */
export function crossSiteWrite(req: Request, port: number): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  const site = req.headers.get("sec-fetch-site");
  // Present on every modern browser request, and it says `same-origin` however
  // the boss spelled the host — `localhost` and `127.0.0.1` are the same page to
  // it and different strings to `Origin`.
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    return !loopback || u.port !== String(port);
  } catch {
    return true;
  }
}

/**
 * The regex table, as a Hono handler.
 *
 * Temporary by design: routes move onto Hono a cluster at a time, and whatever
 * has not moved yet still resolves here. It goes away with the last entry in
 * `ROUTES`. Keeping both alive at once is what makes the move reviewable in
 * pieces instead of as one 3800-line rewrite.
 */
function legacyRoutes(ctx: Ctx): (req: Request) => Promise<Response> {
  return async (req) => {
    const path = new URL(req.url).pathname;
    for (const [method, re, h] of ROUTES) {
      if (req.method !== method) continue;
      const m = re.exec(path);
      if (!m) continue;
      return h(ctx, req, (m.groups ?? {}) as Record<string, string>);
    }
    return text("not found", 404);
  };
}

/**
 * Everything an agent can call, behind one authentication check.
 *
 * `/orch` has no session and no cookie: the only credential is the token minted
 * when the agent was hired, and the mailbox is what carries it out of the
 * sandbox. The prefix gate on the mailbox decides which routes are *reachable*,
 * never who is reaching them — so this middleware is the whole check, and it is
 * one place rather than the first two lines of every handler.
 */
function orchRoutes(ctx: Ctx): Hono<{ Variables: { agent: Caller } }> {
  const app = new Hono<{ Variables: { agent: Caller } }>();
  app.use("*", async (c, next) => {
    const a = agentOf(ctx, c.req.raw);
    // 401, where 19 of these used to say 422 and two said 401. Nothing branches
    // on the difference — `orch` prints the body for anything past 400 — and
    // "you are not who you say you are" has a status code.
    if (!a) return c.text("unknown or missing agent token", 401);
    c.set("agent", a);
    await next();
  });
  const on = (fn: AgentHandler) => (c: { req: { raw: Request; param: () => Record<string, string> }; get: (k: "agent") => Caller }) =>
    fn(ctx, c.req.raw, c.get("agent"), c.req.param());

  app.post("/status", on(postStatus));
  app.post("/journal", on(postJournal));
  app.post("/mail", on(postMail));
  app.post("/ask-boss", on(postAskBoss));
  app.post("/setup", on(postSetup));
  app.post("/lease", on(postLease));
  app.get("/lease/:id/log", on(getLeaseLog));
  app.post("/ctx/query", on(postCtxQuery));
  app.get("/task", on(getTasks));
  app.post("/task/claim", on(postTaskClaim));
  app.post("/task/done", on(postTaskDone));
  app.post("/review", on(postReview));
  app.post("/audit", on(postAudit));
  app.post("/pr", on(postPr));
  app.post("/answer", on(postAnswer2));
  app.post("/triage", on(postTriage));
  app.post("/draft", on(postDraft));
  app.post("/owns", on(postOwns));
  app.post("/drop", on(postDrop));
  app.post("/blocked", on(postBlocked));
  app.post("/split", on(postSplit));
  return app;
}

export function makeApp(ctx: Ctx): (req: Request) => Promise<Response> {
  const app = new Hono();

  // One place, ahead of everything. It used to be an `if` at the top of the
  // dispatch loop, which is the same thing until someone adds a second dispatch
  // path — and a CSRF check that one route can be written around is not a check.
  app.use("/api/*", async (c, next) => {
    if (crossSiteWrite(c.req.raw, ctx.config.port ?? 47821)) {
      return c.text("cross-site writes are refused", 403);
    }
    await next();
  });

  // An uncaught handler error was a 500 with the message in the body, and stays
  // one: `orch` prints this text straight at an agent, and "error: ..." is more
  // use to it than an empty 500.
  app.onError((e, c) => c.text(`error: ${(e as Error)?.message ?? e}`, 500));

  app.route("/orch", orchRoutes(ctx));
  app.all("*", (c) => legacyRoutes(ctx)(c.req.raw));
  return async (req) => app.fetch(req);
}

