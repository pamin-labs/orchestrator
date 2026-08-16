import { Hono } from "hono";
import { check } from "./api/valid.ts";
import type { Caller, Ctx } from "./ctx.ts";
import { agentOf, mayAct, mintToken, resolveGroup, type AgentHandler, type Handler } from "./api/shared.ts";
import { getAuth, getGithubLogin, getGithubRepos, postAuth, postClaudeCancel, postClaudeCode, postClaudeLogin, postCodexDevice, postCodexDeviceCancel, postGithubLogin, postTrailers } from "./api/authflow.ts";
import { bossFact, expandHome, getAttachment, imagePaths, postAttach, postAttachLocal, withAttachments, type Attachment } from "./api/attach.ts";
import { CTX_BUDGET_CHARS, CtxQueryBody, postCtxQuery } from "./api/ctxquery.ts";
import { AnswerBody, ASK_KINDS, AskBossBody, askKind, brief, getAnswerDraft, postAnswer, postAnswer2, postAskBoss, postDelegate, postEscalationRequirement, postRevoke, postTriage, TriageBody } from "./api/escalation.ts";
import { GroupAction, landGroup, postDraftDecision, postGroupControl, postIdea } from "./api/group.ts";
import { getLeaseLog, LeaseBody, postLease } from "./api/lease.ts";
import { MailBody, postMail, postSay, SayBody } from "./api/messaging.ts";
import { getDirs, getNotes, getSkills, postSkill } from "./api/panel.ts";
import { BlockedBody, DraftBody, DropBody, OwnsBody, postBlocked, postDraft, postDrop, postOwns, postSplit, SplitBody } from "./api/planning.ts";
import { postPr, PrBody } from "./api/pr.ts";
import { deleteProject, getProjectConfig, patchProjectConfig, postProject, postSetup } from "./api/project.ts";
import { evictOldestLessons, JournalBody, LESSON_CAP, postJournal, postStatus, StatusBody } from "./api/report.ts";
import { AuditBody, getEvidence, getGateLog, postAudit, postReview, postSliceDecision, ReviewBody } from "./api/review.ts";
import { getSettings, postSetting } from "./api/settings.ts";
import { getImages, getPreflight, getSandbox, getSandboxServer, postImage, postSandboxServerAddr, postSandboxServerRestart, postSandboxServerStart } from "./api/sandbox.ts";
import { getCost, getState, snapshot } from "./api/snapshot.ts";
import { getStream } from "./api/stream.ts";
import { getTasks, postTaskClaim, postTaskDone, TaskDoneBody, TaskRef } from "./api/tasks.ts";

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

/**
 * The panel's routes.
 *
 * The enum-shaped path segments (`approve|reject`, the nine group actions) were
 * doing double duty in the old regex table: routing *and* input validation. Hono
 * matches on `:name` alone, so the enum moves into the handler's schema where a
 * wrong value produces a message instead of a 404 — which is the honest answer
 * to "reject that decision", and was never what a missing route meant.
 */
/**
 * What a route handler is handed, narrowed to the parts these use.
 *
 * Written out rather than imported as Hono's `Context`, because that type is
 * generic over the app's env and every handler here would have to name the same
 * type parameters to say nothing.
 */
type HonoCtx = {
  req: { raw: Request; param: () => Record<string, string>; valid: (t: never) => unknown };
};

/** The body this route's schema produced, if it declared one. */
const valid = (c: HonoCtx): unknown => {
  try {
    return (c.req.valid as (t: string) => unknown)("json");
  } catch {
    return undefined;
  }
};

function apiRoutes(ctx: Ctx): Hono {
  const app = new Hono();
  // `valid("json")` is whatever the route's schema returned, or `undefined` on a
  // route that declares none — the handler decides which of the two it is by
  // taking a `data` parameter or ignoring it.
  const on = (fn: Handler<any>) => (c: HonoCtx) => fn(ctx, c.req.raw, c.req.param(), valid(c));

  app.get("/auth", on(getAuth));
  app.post("/auth", on(postAuth));
  app.post("/auth/claude/login", on(postClaudeLogin));
  app.post("/auth/claude/login/code", on(postClaudeCode));
  app.post("/auth/claude/login/cancel", on(postClaudeCancel));
  app.get("/auth/github", on(getGithubLogin));
  app.post("/auth/github", on(postGithubLogin));
  app.get("/github/repos", on(getGithubRepos));
  app.post("/git/trailers", on(postTrailers));
  app.post("/auth/codex/device", on(postCodexDevice));
  app.post("/auth/codex/device/cancel", on(postCodexDeviceCancel));

  app.get("/preflight", on(getPreflight));
  app.get("/sandbox", on(getSandbox));
  app.get("/sandbox/images", on(getImages));
  app.post("/sandbox/images", on(postImage));
  app.get("/sandbox-server", on(getSandboxServer));
  app.post("/sandbox-server/restart", on(postSandboxServerRestart));
  app.post("/sandbox-server/start", on(postSandboxServerStart));
  app.post("/sandbox-server/addr", on(postSandboxServerAddr));

  app.get("/settings", on(getSettings));
  app.post("/settings", on(postSetting));
  app.get("/state", on(getState));
  app.get("/cost", on(getCost));
  app.get("/stream", on(getStream));
  app.get("/dirs", on(getDirs));
  app.get("/notes", on(getNotes));
  app.get("/skills", on(getSkills));
  app.post("/skills", on(postSkill));

  app.post("/projects", on(postProject));
  app.delete("/projects/:id", on(deleteProject));
  app.get("/project/:id/config", on(getProjectConfig));
  app.post("/project/:id/config", on(patchProjectConfig));

  app.post("/ideas", on(postIdea));
  app.post("/say", check("json", SayBody), on(postSay));
  app.post("/attach", on(postAttach));
  app.post("/attach/local", on(postAttachLocal));
  app.get("/attach/:name", on(getAttachment));

  app.post("/draft/:id/:decision", on(postDraftDecision));
  // No `landed`: whether a PR is merged is GitHub's answer, and `pollPrs` asks it
  // every tick. A button for it was a boss confirming by hand what the server
  // already knew — and one mis-click dissolved a group whose PR was still open.
  app.post("/groups/:id/:action", check("param", GroupAction), on(postGroupControl));

  app.get("/slices/:id/evidence", on(getEvidence));
  app.get("/slices/:id/gate/:name", on(getGateLog));
  app.post("/slices/:id/:decision", on(postSliceDecision));

  app.post("/escalations/:id/answer", on(postAnswer));
  app.post("/escalations/:id/revoke", on(postRevoke));
  app.post("/escalations/:id/requirement", on(postEscalationRequirement));
  app.post("/escalations/:id/delegate", on(postDelegate));
  app.get("/escalations/:id/draft", on(getAnswerDraft));
  return app;
}

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
  const on = (fn: AgentHandler<any>) => (c: HonoCtx & { get: (k: "agent") => Caller }) =>
    fn(ctx, c.req.raw, c.get("agent"), c.req.param(), valid(c));

  app.post("/status", check("json", StatusBody), on(postStatus));
  app.post("/journal", check("json", JournalBody), on(postJournal));
  app.post("/mail", check("json", MailBody), on(postMail));
  app.post("/ask-boss", check("json", AskBossBody), on(postAskBoss));
  app.post("/setup", on(postSetup));
  app.post("/lease", check("json", LeaseBody), on(postLease));
  app.get("/lease/:id/log", on(getLeaseLog));
  app.post("/ctx/query", check("json", CtxQueryBody), on(postCtxQuery));
  app.get("/task", on(getTasks));
  app.post("/task/claim", check("json", TaskRef), on(postTaskClaim));
  app.post("/task/done", check("json", TaskDoneBody), on(postTaskDone));
  app.post("/review", check("json", ReviewBody), on(postReview));
  app.post("/audit", check("json", AuditBody), on(postAudit));
  app.post("/pr", check("json", PrBody), on(postPr));
  app.post("/answer", check("json", AnswerBody), on(postAnswer2));
  app.post("/triage", check("json", TriageBody), on(postTriage));
  app.post("/draft", check("json", DraftBody), on(postDraft));
  app.post("/owns", check("json", OwnsBody), on(postOwns));
  app.post("/drop", check("json", DropBody), on(postDrop));
  app.post("/blocked", check("json", BlockedBody), on(postBlocked));
  app.post("/split", check("json", SplitBody), on(postSplit));
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

  /**
   * A body has to say it is JSON.
   *
   * Hono's validator reads the content type and treats anything else as *no
   * input at all* — so a POST that forgot the header did not fail, it arrived
   * with every field defaulted and the request the caller actually sent thrown
   * away. Silent, and the caller sees a plausible answer to a question it did
   * not ask.
   *
   * It also closes the hole `crossSiteWrite` describes one function down. A
   * cross-site POST cannot set `content-type: application/json` without earning
   * a preflight, so `text/plain` is the shape that attack has to take — and this
   * refuses it before there is a handler to fool.
   *
   * `multipart/form-data` is exempt: uploads read `req.formData()` themselves.
   */
  app.use("*", async (c, next) => {
    const type = c.req.header("content-type") ?? "";
    const hasBody = c.req.raw.body !== null;
    if (hasBody && !/^application\/json\b|^multipart\/form-data\b/.test(type)) {
      return c.text(`this endpoint takes application/json, not ${type || "an unlabelled body"}`, 415);
    }
    await next();
  });

  app.route("/orch", orchRoutes(ctx));
  app.route("/api", apiRoutes(ctx));
  app.all("*", (c) => c.text("not found", 404));
  return async (req) => app.fetch(req);
}

