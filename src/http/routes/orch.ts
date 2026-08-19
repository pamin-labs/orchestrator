import { Hono } from "hono";
import type { ApplyGlobalResponse } from "hono/client";
import type { Ctx } from "../../mech/ctx.ts";
import { agentOf, type Caller } from "../agent-auth.ts";
import { CtxQueryBody, postCtxQuery } from "../../api/orch/ctxquery.ts";
import { IdParams } from "../../contracts/fields.ts";
import { OwnIdempotencyStatusQuery } from "../idempotency/schema.ts";
import {
  AnswerBody,
  AskBossBody,
  postAnswer2,
  postAskBoss,
  postTriage,
  TriageBody,
} from "../../api/orch/escalation.ts";
import { getLeaseLog, LeaseBody, LeaseLogQuery, postLease } from "../../api/orch/lease.ts";
import { MailBody, postMail } from "../../api/orch/messaging.ts";
import {
  BlockedBody,
  DraftBody,
  DropBody,
  OwnsBody,
  postBlocked,
  postDraft,
  postDrop,
  postOwns,
  postSplit,
  SplitBody,
} from "../../api/orch/planning.ts";
import { postPr, postPrResolve, PrBody, PrResolveBody } from "../../api/orch/pr.ts";
import { JournalBody, postJournal, postStatus, StatusBody } from "../../api/orch/report.ts";
import { AuditBody, postAudit, postReview, ReviewBody } from "../../api/orch/review.ts";
import { postSetup, SetupBody } from "../../api/panel/project.ts";
import { getTasks, postTaskClaim, postTaskDone, TaskDoneBody, TaskRef } from "../../api/orch/tasks.ts";
import { jsonBody, pathParams, queryParams } from "../validate.ts";
import { failure, type ErrorResponses } from "../respond.ts";
import { bodyLimit } from "hono/body-limit";
import { idempotency, idempotencyCaller, idempotencyStatus, JSON_BODY_LIMIT } from "../idempotency/store.ts";

/** Explicit authenticated agent routes keep auth and validation ahead of every handler. */
export function orchRoutes(ctx: Ctx) {
  const app = new Hono<{ Variables: { agent: Caller } }>();
  app.use("*", async (c, next) => {
    const agent = agentOf(ctx.db, c.req.raw);
    if (!agent) return failure("unknown or missing agent token", 401);
    c.set("agent", agent);
    return next();
  });
  app.use("*", bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: () => failure("request body is too large", 413) }));
  app.use("*", idempotency(ctx.db));

  return app
    .get("/idempotency/status", queryParams(OwnIdempotencyStatusQuery), (c) =>
      idempotencyStatus(ctx.db, { caller: idempotencyCaller(c.req.raw), ...c.req.valid("query") }),
    )
    .post("/status", ...jsonBody(StatusBody), (c) =>
      postStatus(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/journal", ...jsonBody(JournalBody), (c) =>
      postJournal(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/mail", ...jsonBody(MailBody), (c) =>
      postMail(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/ask-boss", ...jsonBody(AskBossBody), (c) =>
      postAskBoss(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/setup", ...jsonBody(SetupBody), (c) =>
      postSetup(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/lease", ...jsonBody(LeaseBody), (c) =>
      postLease(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .get("/lease/:id/log", pathParams(IdParams), queryParams(LeaseLogQuery), (c) =>
      getLeaseLog(ctx, c.req.raw, c.get("agent"), c.req.valid("param"), c.req.valid("query")),
    )
    .post("/ctx/query", ...jsonBody(CtxQueryBody), (c) =>
      postCtxQuery(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .get("/task", (c) => getTasks(ctx, c.req.raw, c.get("agent")))
    .post("/task/claim", ...jsonBody(TaskRef), (c) =>
      postTaskClaim(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/task/done", ...jsonBody(TaskDoneBody), (c) =>
      postTaskDone(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/review", ...jsonBody(ReviewBody), (c) =>
      postReview(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/audit", ...jsonBody(AuditBody), (c) =>
      postAudit(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/pr", ...jsonBody(PrBody), (c) => postPr(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")))
    .post("/pr/resolve", ...jsonBody(PrResolveBody), (c) =>
      postPrResolve(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/answer", ...jsonBody(AnswerBody), (c) =>
      postAnswer2(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/triage", ...jsonBody(TriageBody), (c) =>
      postTriage(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/draft", ...jsonBody(DraftBody), (c) =>
      postDraft(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/owns", ...jsonBody(OwnsBody), (c) =>
      postOwns(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/drop", ...jsonBody(DropBody), (c) =>
      postDrop(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/blocked", ...jsonBody(BlockedBody), (c) =>
      postBlocked(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    )
    .post("/split", ...jsonBody(SplitBody), (c) =>
      postSplit(ctx, c.req.raw, c.get("agent"), c.req.param(), c.req.valid("json")),
    );
}

export type OrchType = ApplyGlobalResponse<
  ReturnType<typeof orchRoutes>,
  ErrorResponses<400 | 401 | 404 | 409 | 413 | 415 | 500 | 503>
>;
