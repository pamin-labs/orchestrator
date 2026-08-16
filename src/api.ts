import { errText } from "./mech/util/text.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { agentRoute, route } from "./http/route.ts";
import type { Caller, Ctx } from "./ctx.ts";
import { agentOf, mayAct, mintToken, resolveGroup } from "./api/shared.ts";
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
function apiRoutes(ctx: Ctx): Hono {
  const app = new Hono();

  route(app, ctx, "get", "/auth", { handler: getAuth });
  route(app, ctx, "post", "/auth", { body: AuthBody, handler: postAuth });
  route(app, ctx, "post", "/auth/claude/login", { handler: postClaudeLogin });
  route(app, ctx, "post", "/auth/claude/login/code", { body: CodeBody, handler: postClaudeCode });
  route(app, ctx, "post", "/auth/claude/login/cancel", { handler: postClaudeCancel });
  route(app, ctx, "get", "/auth/github", { handler: getGithubLogin });
  route(app, ctx, "post", "/auth/github", { handler: postGithubLogin });
  route(app, ctx, "get", "/github/repos", { handler: getGithubRepos });
  route(app, ctx, "post", "/git/trailers", { body: TrailersBody, handler: postTrailers });
  route(app, ctx, "post", "/auth/codex/device", { handler: postCodexDevice });
  route(app, ctx, "post", "/auth/codex/device/cancel", { handler: postCodexDeviceCancel });

  route(app, ctx, "get", "/preflight", { handler: getPreflight });
  route(app, ctx, "get", "/sandbox", { handler: getSandbox });
  route(app, ctx, "get", "/sandbox/images", { handler: getImages });
  route(app, ctx, "post", "/sandbox/images", { body: ImageBody, handler: postImage });
  route(app, ctx, "get", "/sandbox-server", { handler: getSandboxServer });
  route(app, ctx, "post", "/sandbox-server/restart", { handler: postSandboxServerRestart });
  route(app, ctx, "post", "/sandbox-server/start", { handler: postSandboxServerStart });
  route(app, ctx, "post", "/sandbox-server/addr", { body: AddrBody, handler: postSandboxServerAddr });

  route(app, ctx, "get", "/settings", { handler: getSettings });
  route(app, ctx, "post", "/settings", { body: SettingBody, handler: postSetting });
  route(app, ctx, "get", "/state", { handler: getState });
  route(app, ctx, "get", "/cost", { handler: getCost });
  route(app, ctx, "get", "/stream", { handler: getStream });
  route(app, ctx, "get", "/dirs", { handler: getDirs });
  route(app, ctx, "get", "/notes", { handler: getNotes });
  route(app, ctx, "get", "/skills", { handler: getSkills });
  route(app, ctx, "post", "/skills", { body: SkillBody, handler: postSkill });

  route(app, ctx, "post", "/projects", { body: ProjectBody, handler: postProject });
  route(app, ctx, "delete", "/projects/:id", { handler: deleteProject });
  route(app, ctx, "get", "/project/:id/config", { handler: getProjectConfig });
  route(app, ctx, "post", "/project/:id/config", { body: ProjectConfigBody, handler: patchProjectConfig });

  route(app, ctx, "post", "/ideas", { body: IdeaBody, handler: postIdea });
  route(app, ctx, "post", "/say", { body: SayBody, handler: postSay });
  route(app, ctx, "post", "/attach", { handler: postAttach });
  route(app, ctx, "post", "/attach/local", { body: LocalPathsBody, handler: postAttachLocal });
  route(app, ctx, "get", "/attach/:name", { handler: getAttachment });

  route(app, ctx, "post", "/draft/:id/:decision", { params: DraftDecision, body: DraftDecisionBody, handler: postDraftDecision });
  // No `landed`: whether a PR is merged is GitHub's answer, and `pollPrs` asks it
  // every tick. A button for it was a boss confirming by hand what the server
  // already knew — and one mis-click dissolved a group whose PR was still open.
  route(app, ctx, "post", "/groups/:id/:action", { params: GroupAction, body: GroupControlBody, handler: postGroupControl });

  route(app, ctx, "get", "/slices/:id/evidence", { handler: getEvidence });
  route(app, ctx, "get", "/slices/:id/gate/:name", { handler: getGateLog });
  route(app, ctx, "post", "/slices/:id/:decision", { params: SliceDecision, body: SliceDecisionBody, handler: postSliceDecision });

  route(app, ctx, "post", "/escalations/:id/answer", { body: BossAnswerBody, handler: postAnswer });
  route(app, ctx, "post", "/escalations/:id/revoke", { handler: postRevoke });
  route(app, ctx, "post", "/escalations/:id/requirement", { body: RequirementBody, handler: postEscalationRequirement });
  route(app, ctx, "post", "/escalations/:id/delegate", { body: DelegateBody, handler: postDelegate });
  route(app, ctx, "get", "/escalations/:id/draft", { handler: getAnswerDraft });
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
 * Hono's `csrf()` is that rule, scoped tighter than the eighteen lines it
 * replaced. It fires only on the content types a cross-site form or a `no-cors`
 * fetch can actually produce — `x-www-form-urlencoded`, `multipart/form-data`,
 * `text/plain`, and a *missing* header, which it reads as `text/plain`. An
 * `application/json` POST is not one of them and does not need to be: it cannot
 * leave a page without a preflight, and this server answers no preflight.
 *
 * It also compares `Origin` against `new URL(c.req.url).origin` — the host this
 * request actually arrived on. The version here compared against `config.port`,
 * a number from a file that the request itself is better evidence for;
 * `server.ts` already prefers `server.port` over `cfg.port` when it prints the
 * address, for the same reason.
 *
 * `none` is allowed alongside Hono's default `same-origin`: that is the address
 * bar and a redirect, which have no initiator that could be another site.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Loopback is loopback, whichever way the boss spelled it.
 *
 * `csrf()` compares `Origin` to `new URL(c.req.url).origin` as a string, so a
 * panel opened at `http://localhost:47821` is a different origin from the
 * `127.0.0.1:47821` the request arrives on and its uploads are refused. The
 * browser calls them the same page; only the string disagrees. Port still has to
 * match — another server on this machine is another origin.
 */
const sameOriginWrite = csrf({
  secFetchSite: ["same-origin", "none"],
  origin: (origin, c) => {
    try {
      const u = new URL(origin);
      return LOOPBACK.has(u.hostname) && u.port === new URL(c.req.url).port;
    } catch {
      return false;
    }
  },
});

/**
 * How much one upload may be, in total.
 *
 * `postAttach` refuses a file over 25MB — and refuses it *after* `req.formData()`
 * has parsed the entire multipart body into memory, in the one process that also
 * runs every turn. Dropping a folder is a single gesture that sends forty files,
 * so the per-file number never bounded the request. This does, and `content-length`
 * answers it without reading a byte, which is the shape every browser upload has.
 */
export const UPLOAD_LIMIT = 256 * 1024 * 1024;

/**
 * Does this write say, in its own headers, that another page started it?
 *
 * The half of the old check `csrf()` does not cover. `csrf()` fires only on the
 * content types a cross-site request can produce without a preflight, so a
 * cross-site POST labelled `application/json` went through to the schema —
 * measured, 422 rather than 403, for both a `Sec-Fetch-Site: cross-site` and an
 * `Origin: https://evil.example`. The argument for allowing those is sound (JSON
 * is not a safelisted content type; the preflight it needs is one this server
 * never answers) and it is an argument about how somebody else's browser
 * behaves, when the header that settles it is in the request.
 *
 * A deny-list still: `curl`, `bun test` and the mailbox replay send neither
 * header, and refusing those would refuse everything that is not the panel.
 *
 * `Sec-Fetch-Site` first because it is the one that survives the boss typing
 * `localhost` where the server says `127.0.0.1` — the browser calls both
 * same-origin, `Origin` calls them different strings. So the `Origin` fallback
 * compares loopback-to-loopback and only insists on the port.
 */
export function elsewhere(site: string | undefined, origin: string | undefined, url: string): boolean {
  if (site) return site !== "same-origin" && site !== "none";
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    return !loopback || u.port !== new URL(url).port;
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
  agentRoute(app, ctx, "post", "/status", { body: StatusBody, handler: postStatus });
  agentRoute(app, ctx, "post", "/journal", { body: JournalBody, handler: postJournal });
  agentRoute(app, ctx, "post", "/mail", { body: MailBody, handler: postMail });
  agentRoute(app, ctx, "post", "/ask-boss", { body: AskBossBody, handler: postAskBoss });
  agentRoute(app, ctx, "post", "/setup", { body: SetupBody, handler: postSetup });
  agentRoute(app, ctx, "post", "/lease", { body: LeaseBody, handler: postLease });
  agentRoute(app, ctx, "get", "/lease/:id/log", { handler: getLeaseLog });
  agentRoute(app, ctx, "post", "/ctx/query", { body: CtxQueryBody, handler: postCtxQuery });
  agentRoute(app, ctx, "get", "/task", { handler: getTasks });
  agentRoute(app, ctx, "post", "/task/claim", { body: TaskRef, handler: postTaskClaim });
  agentRoute(app, ctx, "post", "/task/done", { body: TaskDoneBody, handler: postTaskDone });
  agentRoute(app, ctx, "post", "/review", { body: ReviewBody, handler: postReview });
  agentRoute(app, ctx, "post", "/audit", { body: AuditBody, handler: postAudit });
  agentRoute(app, ctx, "post", "/pr", { body: PrBody, handler: postPr });
  agentRoute(app, ctx, "post", "/answer", { body: AnswerBody, handler: postAnswer2 });
  agentRoute(app, ctx, "post", "/triage", { body: TriageBody, handler: postTriage });
  agentRoute(app, ctx, "post", "/draft", { body: DraftBody, handler: postDraft });
  agentRoute(app, ctx, "post", "/owns", { body: OwnsBody, handler: postOwns });
  agentRoute(app, ctx, "post", "/drop", { body: DropBody, handler: postDrop });
  agentRoute(app, ctx, "post", "/blocked", { body: BlockedBody, handler: postBlocked });
  agentRoute(app, ctx, "post", "/split", { body: SplitBody, handler: postSplit });
  return app;
}

export function makeApp(ctx: Ctx): (req: Request) => Promise<Response> {
  const app = new Hono();

  // One place, ahead of everything. It used to be an `if` at the top of the
  // dispatch loop, which is the same thing until someone adds a second dispatch
  // path — and a CSRF check that one route can be written around is not a check.
  //
  // The one thing Hono is not asked to decide: `csrf()` refuses a request that
  // carries neither header, and every legitimate non-browser caller — `curl`,
  // `bun test`, the mailbox replay — carries neither. A browser able to mount
  // this attack always sends at least one, so "both absent" is not a browser and
  // is the only case waved through by hand.
  //
  // And one thing it is not asked to decide either way. `csrf()` fires only on
  // the content types a cross-site request can produce without a preflight, so a
  // cross-site POST that says `application/json` goes through to the schema —
  // measured, 422 not 403. The reasoning for that is sound (JSON is not a
  // safelisted content type, the preflight it needs is one this server never
  // answers) but it is reasoning about someone else's browser, and the header
  // saying so is right there. A browser is the only thing that sets
  // `Sec-Fetch-Site`, it cannot be set from script, and no legitimate caller of
  // this surface sets it to anything but `same-origin` or `none`.
  app.use("/api/*", async (c, next) => {
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && elsewhere(site, origin, c.req.url)) {
      return c.text("cross-site writes are refused", 403);
    }
    if (site || origin) return sameOriginWrite(c, next);
    await next();
  });

  // The only route that takes an unbounded body. See `UPLOAD_LIMIT`.
  app.use(
    "/api/attach",
    bodyLimit({ maxSize: UPLOAD_LIMIT, onError: (c) => c.text(`一次最多传 ${UPLOAD_LIMIT >> 20}MB`, 413) }),
  );

  // An uncaught handler error was a 500 with the message in the body, and stays
  // one: `orch` prints this text straight at an agent, and "error: ..." is more
  // use to it than an empty 500.
  //
  // Middleware that already picked a status says so by throwing `HTTPException`,
  // and setting `onError` replaces Hono's default handler outright — without
  // this branch `csrf()`'s 403 would arrive as a 500 saying "error: Forbidden".
  app.onError((e, c) => (e instanceof HTTPException ? e.getResponse() : c.text(`error: ${errText(e)}`, 500)));

  app.route("/orch", orchRoutes(ctx));
  app.route("/api", apiRoutes(ctx));
  app.all("*", (c) => c.text("not found", 404));
  return async (req) => app.fetch(req);
}

