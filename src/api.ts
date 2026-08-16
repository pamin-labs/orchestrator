import { errText } from "./mech/util/text.ts";
import { Hono } from "hono";
import { check } from "./api/valid.ts";
import type { Caller, Ctx } from "./ctx.ts";
import { agentOf, mayAct, mintToken, resolveGroup, type AgentHandler, type Handler } from "./api/shared.ts";
import { AuthBody, CodeBody, getAuth, getGithubLogin, getGithubRepos, postAuth, postClaudeCancel, postClaudeCode, postClaudeLogin, postCodexDevice, postCodexDeviceCancel, postGithubLogin, postTrailers, TrailersBody } from "./api/panel/authflow.ts";
import { bossFact, expandHome, getAttachment, imagePaths, LocalPathsBody, postAttach, postAttachLocal, withAttachments, type Attachment } from "./api/panel/attach.ts";
import { CTX_BUDGET_CHARS, CtxQueryBody, postCtxQuery } from "./api/orch/ctxquery.ts";
import { AnswerBody, ASK_KINDS, AskBossBody, askKind, BossAnswerBody, brief, DelegateBody, getAnswerDraft, postAnswer, postAnswer2, postAskBoss, postDelegate, postEscalationRequirement, postRevoke, postTriage, RequirementBody, TriageBody } from "./api/orch/escalation.ts";
import { DraftDecision, DraftDecisionBody, GroupAction, GroupControlBody, IdeaBody, landGroup, postDraftDecision, postGroupControl, postIdea } from "./api/panel/group.ts";
import { getLeaseLog, LeaseBody, postLease } from "./api/orch/lease.ts";
import { MailBody, postMail, postSay, SayBody } from "./api/orch/messaging.ts";
import { getDirs, getNotes, getSkills, postSkill, SkillBody } from "./api/panel/panel.ts";
import { BlockedBody, DraftBody, DropBody, OwnsBody, postBlocked, postDraft, postDrop, postOwns, postSplit, SplitBody } from "./api/orch/planning.ts";
import { postPr, PrBody } from "./api/orch/pr.ts";
import { deleteProject, getProjectConfig, patchProjectConfig, postProject, postSetup, ProjectBody, ProjectConfigBody, SetupBody } from "./api/panel/project.ts";
import { evictOldestLessons, JournalBody, LESSON_CAP, postJournal, postStatus, StatusBody } from "./api/orch/report.ts";
import { AuditBody, getEvidence, getGateLog, postAudit, postReview, postSliceDecision, ReviewBody, SliceDecision, SliceDecisionBody } from "./api/orch/review.ts";
import { getSettings, postSetting, SettingBody } from "./api/panel/settings.ts";
import { AddrBody, getImages, getPreflight, getSandbox, getSandboxServer, ImageBody, postImage, postSandboxServerAddr, postSandboxServerRestart, postSandboxServerStart } from "./api/panel/sandbox.ts";
import { getCost, getState, snapshot } from "./api/panel/snapshot.ts";
import { getStream } from "./api/panel/stream.ts";
import { getTasks, postTaskClaim, postTaskDone, TaskDoneBody, TaskRef } from "./api/orch/tasks.ts";

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
  app.post("/auth", check("json", AuthBody), on(postAuth));
  app.post("/auth/claude/login", on(postClaudeLogin));
  app.post("/auth/claude/login/code", check("json", CodeBody), on(postClaudeCode));
  app.post("/auth/claude/login/cancel", on(postClaudeCancel));
  app.get("/auth/github", on(getGithubLogin));
  app.post("/auth/github", on(postGithubLogin));
  app.get("/github/repos", on(getGithubRepos));
  app.post("/git/trailers", check("json", TrailersBody), on(postTrailers));
  app.post("/auth/codex/device", on(postCodexDevice));
  app.post("/auth/codex/device/cancel", on(postCodexDeviceCancel));

  app.get("/preflight", on(getPreflight));
  app.get("/sandbox", on(getSandbox));
  app.get("/sandbox/images", on(getImages));
  app.post("/sandbox/images", check("json", ImageBody), on(postImage));
  app.get("/sandbox-server", on(getSandboxServer));
  app.post("/sandbox-server/restart", on(postSandboxServerRestart));
  app.post("/sandbox-server/start", on(postSandboxServerStart));
  app.post("/sandbox-server/addr", check("json", AddrBody), on(postSandboxServerAddr));

  app.get("/settings", on(getSettings));
  app.post("/settings", check("json", SettingBody), on(postSetting));
  app.get("/state", on(getState));
  app.get("/cost", on(getCost));
  app.get("/stream", on(getStream));
  app.get("/dirs", on(getDirs));
  app.get("/notes", on(getNotes));
  app.get("/skills", on(getSkills));
  app.post("/skills", check("json", SkillBody), on(postSkill));

  app.post("/projects", check("json", ProjectBody), on(postProject));
  app.delete("/projects/:id", on(deleteProject));
  app.get("/project/:id/config", on(getProjectConfig));
  app.post("/project/:id/config", check("json", ProjectConfigBody), on(patchProjectConfig));

  app.post("/ideas", check("json", IdeaBody), on(postIdea));
  app.post("/say", check("json", SayBody), on(postSay));
  app.post("/attach", on(postAttach));
  app.post("/attach/local", check("json", LocalPathsBody), on(postAttachLocal));
  app.get("/attach/:name", on(getAttachment));

  app.post("/draft/:id/:decision", check("param", DraftDecision), check("json", DraftDecisionBody), on(postDraftDecision));
  // No `landed`: whether a PR is merged is GitHub's answer, and `pollPrs` asks it
  // every tick. A button for it was a boss confirming by hand what the server
  // already knew — and one mis-click dissolved a group whose PR was still open.
  app.post("/groups/:id/:action", check("param", GroupAction), check("json", GroupControlBody), on(postGroupControl));

  app.get("/slices/:id/evidence", on(getEvidence));
  app.get("/slices/:id/gate/:name", on(getGateLog));
  app.post("/slices/:id/:decision", check("param", SliceDecision), check("json", SliceDecisionBody), on(postSliceDecision));

  app.post("/escalations/:id/answer", check("json", BossAnswerBody), on(postAnswer));
  app.post("/escalations/:id/revoke", on(postRevoke));
  app.post("/escalations/:id/requirement", check("json", RequirementBody), on(postEscalationRequirement));
  app.post("/escalations/:id/delegate", check("json", DelegateBody), on(postDelegate));
  app.get("/escalations/:id/draft", on(getAnswerDraft));
  return app;
}

/**
 * Is this write coming from somewhere other than the panel?
 *
 * `/api/*` takes no token — its caller is a browser on 127.0.0.1 and the port is
 * the whole authentication story. That stops the network and does not stop a web
 * page: a POST with the default `text/plain` used to be a *simple* request —
 * no preflight, delivered, and parsed. The attacker cannot read the reply and
 * does not need to: wiping the boss's credentials, approving a DRAFT and
 * dropping a group are all one-way.
 *
 * Two things stop it now. This, and the content-type gate in `makeApp` — a body
 * that does not say `application/json` is refused before a route sees it, and
 * saying it is what earns the preflight this was written to survive.
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
  app.post("/setup", check("json", SetupBody), on(postSetup));
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
  app.onError((e, c) => c.text(`error: ${errText(e)}`, 500));

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

