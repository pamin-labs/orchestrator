import { Hono } from "hono";
import type { ApplyGlobalResponse } from "hono/client";
import { streamSSE } from "hono/streaming";
import type { Ctx } from "../../mech/ctx.ts";
import { IdParams } from "../../contracts/fields.ts";
import { IdempotencyRecoveryBody, IdempotencyStatusQuery } from "../idempotency/schema.ts";
import {
  AuthBody,
  CodeBody,
  getAuth,
  getGithubLogin,
  getGithubRepos,
  GithubReposQuery,
  postAuth,
  postClaudeCancel,
  postClaudeCode,
  postClaudeLogin,
  postCodexDevice,
  postCodexDeviceCancel,
  postGithubLogin,
  postTrailers,
  TrailersBody,
} from "../../api/panel/authflow.ts";
import {
  AttachForm,
  AttachmentNameParams,
  getAttachment,
  LocalPathsBody,
  postAttach,
  postAttachLocal,
} from "../../api/panel/attach.ts";
import {
  BossAnswerBody,
  DelegateBody,
  getAnswerDraft,
  postAnswer,
  postDelegate,
  postEscalationRequirement,
  postRevoke,
  RequirementBody,
} from "../../api/orch/escalation.ts";
import {
  DraftDecision,
  DraftDecisionBody,
  GroupAction,
  GroupControlBody,
  IdeaBody,
  postDraftDecision,
  postGroupControl,
  postIdea,
} from "../../api/panel/group.ts";
import { postSay, SayBody } from "../../api/orch/messaging.ts";
import {
  DirsQuery,
  getDirs,
  getNotes,
  getSkills,
  NotesQuery,
  postSkill,
  SkillBody,
  SkillsQuery,
} from "../../api/panel/panel.ts";
import {
  deleteProject,
  getProjectConfig,
  patchProjectConfig,
  postProject,
  ProjectBody,
  ProjectConfigBody,
} from "../../api/panel/project.ts";
import {
  GateLogQuery,
  GateLogParams,
  getEvidence,
  getGateLog,
  postSliceDecision,
  SliceDecision,
  SliceDecisionBody,
} from "../../api/orch/review.ts";
import { getSettings, postSetting, SettingBody } from "../../api/panel/settings.ts";
import {
  AddrBody,
  getImages,
  getPreflight,
  getSandbox,
  getSandboxServer,
  ImageBody,
  postImage,
  postSandboxServerAddr,
  postSandboxServerRestart,
  postSandboxServerStart,
  SandboxQuery,
} from "../../api/panel/sandbox.ts";
import { CostQuery, getCost, getState } from "../../api/panel/snapshot.ts";
import { OtlpTraceBody, postTraces } from "../../api/panel/traces.ts";
import { getStream, StreamQuery } from "../../api/panel/stream.ts";
import { formBody, jsonBody, pathParams, queryParams } from "../validate.ts";
import type { ErrorResponses } from "../respond.ts";
import { operatorIdempotencyStatus, recoverIdempotency } from "../idempotency/store.ts";

/** Explicit panel routes keep Hono's request and response types visible to RPC. */
export function panelRoutes(ctx: Ctx) {
  const app = new Hono()
    .get("/idempotency/status", queryParams(IdempotencyStatusQuery), (c) =>
      operatorIdempotencyStatus(ctx.db, c.req.valid("query")),
    )
    .post("/idempotency/recover", ...jsonBody(IdempotencyRecoveryBody), (c) =>
      recoverIdempotency(ctx.db, c.req.valid("json")),
    )
    .get("/auth", () => getAuth(ctx))
    .post("/auth", ...jsonBody(AuthBody), (c) => postAuth(ctx, c.req.raw, c.req.param(), c.req.valid("json")))
    .post("/auth/claude/login", () => postClaudeLogin(ctx))
    .post("/auth/claude/login/code", ...jsonBody(CodeBody), (c) =>
      postClaudeCode(ctx, c.req.raw, c.req.param(), c.req.valid("json")),
    )
    .post("/auth/claude/login/cancel", () => postClaudeCancel(ctx))
    .get("/auth/github", (c) => getGithubLogin(ctx, c.req.raw))
    .post("/auth/github", () => postGithubLogin(ctx))
    .get("/github/repos", queryParams(GithubReposQuery), (c) =>
      getGithubRepos(ctx, c.req.raw, c.req.param(), c.req.valid("query")),
    )
    .post("/git/trailers", ...jsonBody(TrailersBody), (c) =>
      postTrailers(ctx, c.req.raw, c.req.param(), c.req.valid("json")),
    )
    .post("/auth/codex/device", () => postCodexDevice(ctx))
    .post("/auth/codex/device/cancel", () => postCodexDeviceCancel(ctx))
    .get("/preflight", () => getPreflight(ctx))
    .get("/sandbox", queryParams(SandboxQuery), (c) => getSandbox(ctx, c.req.raw, c.req.param(), c.req.valid("query")))
    .get("/sandbox/images", () => getImages(ctx))
    .post("/sandbox/images", ...jsonBody(ImageBody), (c) =>
      postImage(ctx, c.req.raw, c.req.param(), c.req.valid("json")),
    )
    .get("/sandbox-server", () => getSandboxServer(ctx))
    .post("/sandbox-server/restart", () => postSandboxServerRestart(ctx))
    .post("/sandbox-server/start", () => postSandboxServerStart(ctx))
    .post("/sandbox-server/addr", ...jsonBody(AddrBody), (c) =>
      postSandboxServerAddr(ctx, c.req.raw, c.req.param(), c.req.valid("json")),
    )
    .get("/settings", () => getSettings(ctx))
    .post("/settings", ...jsonBody(SettingBody), (c) => postSetting(ctx, c.req.raw, c.req.param(), c.req.valid("json")))
    .get("/state", () => getState(ctx))
    .get("/cost", queryParams(CostQuery), (c) => getCost(ctx, c.req.raw, c.req.param(), c.req.valid("query")))
    .get("/stream", queryParams(StreamQuery), (c) =>
      streamSSE(c, (stream) => getStream(ctx, c.req.raw, c.req.valid("query"), stream)),
    )
    .get("/dirs", queryParams(DirsQuery), (c) => getDirs(ctx, c.req.raw, c.req.param(), c.req.valid("query")))
    .get("/notes", queryParams(NotesQuery), (c) => getNotes(ctx, c.req.raw, c.req.param(), c.req.valid("query")))
    .get("/skills", queryParams(SkillsQuery), (c) => getSkills(ctx, c.req.raw, c.req.param(), c.req.valid("query")))
    .post("/skills", ...jsonBody(SkillBody), (c) => postSkill(ctx, c.req.raw, c.req.param(), c.req.valid("json")))
    .post("/projects", ...jsonBody(ProjectBody), (c) => postProject(ctx, c.req.raw, c.req.param(), c.req.valid("json")))
    .delete("/projects/:id", pathParams(IdParams), (c) => deleteProject(ctx, c.req.raw, c.req.valid("param")))
    .get("/project/:id/config", pathParams(IdParams), (c) => getProjectConfig(ctx, c.req.raw, c.req.valid("param")))
    .post("/project/:id/config", pathParams(IdParams), ...jsonBody(ProjectConfigBody), (c) =>
      patchProjectConfig(ctx, c.req.raw, c.req.valid("param"), c.req.valid("json")),
    )
    .post("/ideas", ...jsonBody(IdeaBody), (c) => postIdea(ctx, c.req.raw, c.req.param(), c.req.valid("json")))
    .post("/say", ...jsonBody(SayBody), (c) => postSay(ctx, c.req.raw, c.req.param(), c.req.valid("json")))
    .post("/attach", formBody(AttachForm), (c) => postAttach(ctx, c.req.raw, c.req.param(), c.req.valid("form")))
    .post("/attach/local", ...jsonBody(LocalPathsBody), (c) =>
      postAttachLocal(ctx, c.req.raw, c.req.param(), c.req.valid("json")),
    )
    .get("/attach/:name", pathParams(AttachmentNameParams), (c) => getAttachment(ctx, c.req.raw, c.req.valid("param")))
    .post("/draft/:id/:decision", pathParams(DraftDecision), ...jsonBody(DraftDecisionBody), (c) =>
      postDraftDecision(ctx, c.req.raw, c.req.valid("param"), c.req.valid("json")),
    )
    .post("/groups/:id/:action", pathParams(GroupAction), ...jsonBody(GroupControlBody), (c) =>
      postGroupControl(ctx, c.req.raw, c.req.valid("param"), c.req.valid("json")),
    )
    .get("/slices/:id/evidence", pathParams(IdParams), (c) => getEvidence(ctx, c.req.raw, c.req.valid("param")))
    .get("/slices/:id/gate/:name", pathParams(GateLogParams), queryParams(GateLogQuery), (c) =>
      getGateLog(ctx, c.req.raw, c.req.valid("param"), c.req.valid("query")),
    )
    .post("/slices/:id/:decision", pathParams(SliceDecision), ...jsonBody(SliceDecisionBody), (c) =>
      postSliceDecision(ctx, c.req.raw, c.req.valid("param"), c.req.valid("json")),
    )
    .post("/escalations/:id/answer", pathParams(IdParams), ...jsonBody(BossAnswerBody), (c) =>
      postAnswer(ctx, c.req.raw, c.req.valid("param"), c.req.valid("json")),
    )
    .post("/escalations/:id/revoke", pathParams(IdParams), (c) => postRevoke(ctx, c.req.raw, c.req.valid("param")))
    .post("/escalations/:id/requirement", pathParams(IdParams), ...jsonBody(RequirementBody), (c) =>
      postEscalationRequirement(ctx, c.req.raw, c.req.valid("param"), c.req.valid("json")),
    )
    .post("/escalations/:id/delegate", pathParams(IdParams), ...jsonBody(DelegateBody), (c) =>
      postDelegate(ctx, c.req.raw, c.req.valid("param"), c.req.valid("json")),
    )
    .get("/escalations/:id/draft", pathParams(IdParams), (c) => getAnswerDraft(ctx, c.req.raw, c.req.valid("param")));

  // An OTLP client appends `/v1/traces` to its configured endpoint, so this is
  // where `OTEL_EXPORTER_OTLP_ENDPOINT=http://host/api` delivers. See
  // `api/panel/traces.ts` for why the path is on this root and not its own.
  //
  // Registered as a statement rather than another link in the chain above, so it
  // stays out of `ApiType`. Nothing in the browser calls it — the caller is a
  // tracing SDK — and one more route in the inferred RPC type is what tips
  // `hc<ApiType>` over TS7056, the point where the compiler refuses to serialize
  // the type at all. The route is registered either way; only the type is not.
  app.post("/traces", ...jsonBody(OtlpTraceBody), (c) =>
    postTraces(ctx, c.req.raw, c.req.param(), c.req.valid("json")),
  );
  return app;
}

export type ApiType = ApplyGlobalResponse<
  ReturnType<typeof panelRoutes>,
  ErrorResponses<400 | 403 | 404 | 409 | 413 | 415 | 500 | 503>
>;
