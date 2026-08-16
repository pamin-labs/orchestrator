import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { relinkSkills } from "./mech/sandbox/sandbox.ts";
import { checkPrMessage } from "./mech/git/prwatch.ts";
import { query as ctxQuery, DEFAULT_BUDGET } from "./mech/knowledge/ctx.ts";
import { loadTree, NOTE_PREFIX, render, search } from "./mech/knowledge/pageindex.ts";
import { listSkills, projectSkills, projectSkillsPending, restageSkills, setSkillOff, skillsOff } from "./mech/util/skills.ts";
import { Hono } from "hono";
import { agentOf, bad, body, json, mayAct, mintToken, resolveGroup, text, type AgentHandler, type Handler } from "./api/shared.ts";
import { getTasks, postTaskClaim, postTaskDone } from "./api/tasks.ts";
import { getCost, getState, snapshot } from "./api/snapshot.ts";
import { bossFact, expandHome, getAttachment, imagePaths, postAttach, postAttachLocal, withAttachments, type Attachment } from "./api/attach.ts";
import { postBlocked, postDraft, postDrop, postOwns, postSplit } from "./api/planning.ts";
import { evictOldestLessons, LESSON_CAP, postJournal, postStatus } from "./api/report.ts";
import { postMail, postSay } from "./api/messaging.ts";
import { getLeaseLog, postLease } from "./api/lease.ts";
import { getEvidence, getGateLog, postAudit, postReview, postSliceDecision } from "./api/review.ts";
import { landGroup, postDraftDecision, postGroupControl, postIdea } from "./api/group.ts";
import { deleteProject, getProjectConfig, patchProjectConfig, postProject, postSetup } from "./api/project.ts";
import { getImages, getPreflight, getSandbox, getSandboxServer, postImage, postSandboxServerAddr, postSandboxServerRestart, postSandboxServerStart } from "./api/sandbox.ts";

// `landGroup` is called by the server and the watchdog when a PR merges.
export { landGroup };

// The lesson cap is asserted in a test; eviction is called from the note route.
export { evictOldestLessons, LESSON_CAP };
import { ASK_KINDS, askKind, brief, getAnswerDraft, postAnswer, postAnswer2, postAskBoss, postDelegate, postEscalationRequirement, postRevoke, postTriage } from "./api/escalation.ts";

// The queue groups by kind and shows the brief; both are read outside the routes.
export { ASK_KINDS, askKind, brief };

// `bossFact` is called from the answer chain, `imagePaths` and `withAttachments`
// from the executor. Re-exported so those two keep one import each.
export { bossFact, expandHome, imagePaths, withAttachments, type Attachment };

// The panel payload. Re-exported: several tests build a fleet and assert on it.
export { snapshot };
import { getAuth, getGithubLogin, getGithubRepos, postAuth, postClaudeCancel, postClaudeCode, postClaudeLogin, postCodexDevice, postCodexDeviceCancel, postGithubLogin, postTrailers } from "./api/authflow.ts";

// Re-exported: `mintToken` and `agentOf` are wired from outside the routes, and
// the tests reach for them here.
export { agentOf, mayAct, mintToken, resolveGroup };
import type { Caller, Ctx } from "./ctx.ts";

// Both live in `ctx.ts` now — eighteen files under `mech/` want the type and
// nothing else here. Re-exported so no importer had to change.
export type { Caller, Ctx };

/**
 * One API, two clients: the web UI (the boss's main surface) and `orch` (what
 * agents call over Bash). Anything the web can do has an `orch` verb and vice
 * versa — there is deliberately no second implementation anywhere.
 */

// ---------------------------------------------------------------- agent verbs









/**
 * The line the queue shows.
 *
 * Asked for with `--brief`, because the agent knows what its question is about
 * and the queue cannot work it out from prose written for another agent. Derived
 * when it is missing rather than rejected: a question that cannot be filed is an
 * agent stuck on a formatting rule, and the fallback is right often enough — the
 * first sentence of a question usually names the problem.
 */










/** The Architect cuts a group's boundary before work is planned inside it. */





/**
 * The Scribe's message, and the thing that publishes the branch.
 *
 * The validator is the convention — the role's prompt states these four
 * refusals by name, and `checkPrMessage` is what enforces them. A Scribe that
 * gets it wrong is told which rule and can send it again within the same turn:
 * nothing is published until one lands, so there is no half state to undo.
 */
const postPr: AgentHandler = async (ctx, req, a) => {
  const b = await body<{ group_id: number | string; title: string; body?: string }>(req);
  if (a.role !== "scribe") return bad(`${a.role} does not write pull request messages`);
  const gid = resolveGroup(ctx, b.group_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx, a, gid)) return text("not your project", 403);

  const title = (b.title ?? "").trim();
  const summary = (b.body ?? "").trim();
  const wrong = checkPrMessage(title, summary);
  if (wrong) return bad(wrong);

  const g = ctx.db
    .query<{ status: string; pr_number: number | null }, [number]>("SELECT status, pr_number FROM grp WHERE id = ?")
    .get(gid);
  if (!g) return bad("no such group");
  ctx.db.run("UPDATE grp SET pr_title = ?, pr_summary = ? WHERE id = ?", [title, summary, gid]);
  ctx.bus.emit({
    grpId: gid,
    author: "scribe",
    kind: "note",
    intent: "note",
    body: title,
  });
  // Already open: the message is stored and `openPr` PATCHes the existing one
  // rather than opening a second. Publishing is still the same call either way.
  ctx.publishBranch?.(gid);
  return text("ok");
};


const postCtxQuery: AgentHandler = async (ctx, req, a) => {
  const b = await body<{ question: string; limit?: number }>(req);
  const projectId =
    ctx.db
      .query<{ project_id: number | null }, [number]>("SELECT project_id FROM agent WHERE id = ?")
      .get(a.id)?.project_id ?? null;
  // PageIndex: a model walks the summary tree and can land on a file whose name
  // shares no word with the question. It costs one cheap call, against grep rounds
  // that each re-read the agent's whole transcript. No tree yet, or a navigator
  // that fails, falls through to the lexical map inside ctxQuery.
  let where = "";
  const tree = loadTree(ctx.db, projectId);
  if (tree && ctx.askIn && projectId) {
    try {
      // In the caller's own sandbox, not the project's.
      //
      // The walk reads nothing from a checkout: the menu is built from summaries
      // already in the database and the model answers with ids. So the container
      // it runs in cannot change the answer — and routing every group's query into
      // the one project sandbox would put ten agents' first step through a single
      // container with a single CPU quota, on the step `assemble.ts` tells every
      // role to take FIRST. The index *build* stays project-scoped; it is shared
      // work and there is one of it.
      const scope = a.grp_id ? { grp: a.grp_id } : { project: projectId };
      const hits = await search(tree, b.question, ctx.askIn(scope));
      if (hits.length) {
        where = render(tree, hits);
        // A note the walk landed on is the answer, not a pointer to it: journals and
        // retros are already short, and making the agent go and fetch one costs
        // another round, which is the thing this whole path exists to avoid.
        const noteIds = hits.filter((h) => h.startsWith(NOTE_PREFIX)).map((h) => Number(h.split("/").pop()));
        for (const id of noteIds) {
          const n = ctx.db
            .query<{ kind: string; body: string }, [number]>("SELECT kind, body FROM note WHERE id = ?")
            .get(id);
          if (n) where += `\n\n### ${n.kind} #${id}\n${n.body.slice(0, 1200)}`;
        }
      }
    } catch {}
  }
  return text(
    ctxQuery({
      db: ctx.db,
      grpId: a.grp_id,
      projectId,
      question: b.question,
      where,
      // From config, not the module default: `ctxBudgetChars` was a setting that
      // read back as itself and changed nothing, because nobody ever passed it here.
      budget: b.limit ?? ctx.config.ctxBudgetChars ?? CTX_BUDGET_CHARS,
    }),
  );
};

export const CTX_BUDGET_CHARS = DEFAULT_BUDGET;






// ------------------------------------------------------------------ boss verbs


























/** Idle SSE connections get dropped by proxies and by browsers' own timeouts. */
const SSE_HEARTBEAT_MS = 25_000;



/**
 * This machine's directories, for the **attachment** picker and nothing else.
 *
 * It used to be how a project was added, which is why it reports `.git` on each
 * entry — a project is a GitHub repository now and comes from the repo list. It
 * stays because attaching a file or a folder to a message is genuinely about
 * this machine: a browser cannot hand over a real path.
 *
 * Names only, never contents: this endpoint has no business reading files, and
 * the page it serves only needs to know what to offer.
 */
/**
 * The blackboard's static half, readable.
 *
 * `note` holds every journal, decision, retro, risk, handoff, onboarding pack and
 * lesson — PLAN.md §7 calls the lesson list "the only mechanism by which the
 * twentieth group is smarter than the first" — and none of it was reachable from
 * the panel at all. Agents could `orch ctx query` it; the boss could not read it.
 */
const getNotes: Handler = async (ctx, req) => {
  const q = new URL(req.url).searchParams;
  const project = q.get("project");
  const group = q.get("group");
  const kind = q.get("kind");
  const where: string[] = [];
  const args: any[] = [];
  if (group) {
    where.push("n.grp_id = ?");
    args.push(Number(group));
  } else if (project) {
    // Project scope includes the standing notes (onboarding, lessons) that belong
    // to no group, which is exactly where they matter.
    where.push("(n.project_id = ? OR g.project_id = ?)");
    args.push(Number(project), Number(project));
  }
  if (kind) {
    where.push("n.kind = ?");
    args.push(kind);
  }
  // The draft card is a note too, and it already has its own screen.
  where.push("coalesce(json_extract(n.frontmatter_json, '$.draft_card'), 0) != 1");
  // Nor are the index's own rows notes: `pageindex` is a serialised tree and
  // `map` is a rendered directory listing, both stored here because `note` was
  // the table that already existed. Neither is anything the boss reads.
  where.push("n.kind NOT IN ('pageindex', 'map')");

  const rows = ctx.db
    .query<unknown, any[]>(
      `SELECT n.id, n.grp_id AS grpId, n.kind, n.body, n.at, n.export_path AS exportPath,
              n.frontmatter_json AS frontmatter, g.name AS "group"
       FROM note n LEFT JOIN grp g ON g.id = n.grp_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY n.at DESC LIMIT 300`,
    )
    .all(...args);
  return json({ notes: rows });
};

/**
 * Every skill on this machine, and whether agents can see it.
 *
 * `on` is what the boss ticked: those get staged into the directory every sandbox
 * mounts, so an agent discovers and invokes them itself. Unticked ones are still
 * listed — naming one in a requirement injects it into that single turn — which is
 * why the composer offers all of them and asks before using an unticked one.
 */
const getSkills: Handler = async (ctx, req) => {
  const id = Number(new URL(req.url).searchParams.get("project"));
  const repo = ctx.db
    .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
    .get(id)?.repo_path;
  projectSkillsPending(ctx, id, repo);
  const off = new Set(skillsOff(ctx.db));
  return json({
    skills: listSkills(repo, projectSkills(ctx.db, id)).map(({ name, rel, description, scope }) => ({
      name,
      path: rel,
      description,
      scope,
      // A project skill ships with the repository the group is working on, so it
      // is always delivered and there is nothing to tick.
      on: scope === "project" || !off.has(name),
    })),
  });
};

/**
 * Tick or untick one skill, then rebuild the staging directory.
 *
 * Rebuilt now rather than at the next sandbox: the mount is a directory, so what
 * changes here is visible to every running container as soon as the next turn's CLI
 * process starts. No sandbox is rebuilt for a tick box.
 */
const postSkill: Handler = async (ctx, req) => {
  const b = (await req.json().catch(() => ({}))) as { name?: string; on?: boolean };
  // No name is a rescan: the boss installed or removed a skill outside this
  // process, and the staged copy is the only thing that does not know yet.
  if (b.name) setSkillOff(ctx.db, b.name, b.on === false);
  const { staged, failed } = restageSkills(ctx.db, ctx.config?.skillsDir ?? "/var/tmp/orch-cache/skills");
  // The mount is a staging path now, not either CLI's own directory, so a
  // changed set is not visible until the links are rebuilt. Every live
  // container, because a standing agent's container has no checkout and so no
  // other moment that would ever redo them.
  await relinkSkills();
  return json({ staged: staged.length, failed });
};

const getDirs: Handler = async (ctx, req) => {
  const q = new URL(req.url).searchParams;
  const asked = q.get("path") ?? homedir();
  const path = resolve(expandHome(asked));
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (e) {
    return bad(`${path}: ${(e as Error).message}`);
  }
  const taken = new Set(
    ctx.db.query<{ repo_path: string }, []>("SELECT repo_path FROM project").all().map((r) => r.repo_path),
  );
  const dirs = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const full = join(path, d.name);
      return { name: d.name, path: full, repo: existsSync(join(full, ".git")), taken: taken.has(full) };
    })
    .sort((a, b) => (a.repo === b.repo ? a.name.localeCompare(b.name) : a.repo ? -1 : 1));
  // Files only when someone is picking files. The repo picker asking for them
  // would list a thousand entries in a source directory to choose one folder.
  const files = q.get("files")
    ? entries
        .filter((d) => d.isFile() && !d.name.startsWith("."))
        .map((d) => {
          const full = join(path, d.name);
          let size = 0;
          try {
            size = statSync(full).size;
          } catch {}
          return { name: d.name, path: full, size };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  // A repo can be picked at any level, including the one being listed.
  return json({
    path,
    parent: path === "/" ? null : dirname(path),
    repo: existsSync(join(path, ".git")),
    dirs,
    files,
  });
};

const getStream: Handler = async (ctx, req) => {
  const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
  let unsub = () => {};
  let beat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      const raw = (s: string) => {
        try {
          c.enqueue(enc.encode(s));
          return true;
        } catch {
          unsub();
          if (beat) clearInterval(beat);
          return false;
        }
      };
      // Which project a frame belongs to, so the feed can be scoped. grp -> project
      // is immutable, so it is cached rather than queried per frame — live frames
      // arrive per token.
      const ofGrp = new Map<number, number | null>();
      const projectOf = (grpId: number | null | undefined): number | null => {
        if (grpId == null) return null;
        if (!ofGrp.has(grpId)) {
          ofGrp.set(
            grpId,
            ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId)
              ?.project_id ?? null,
          );
        }
        return ofGrp.get(grpId) ?? null;
      };
      const send = (data: any) =>
        raw(`data: ${JSON.stringify({ ...data, projectId: data.projectId ?? projectOf(data.grpId) })}\n\n`);

      // A stream that sends nothing has sent no bytes, and a browser does not
      // report a byteless response as open — the UI sat on "connecting…" forever
      // on a fresh database with no events to replay. The comment also defeats
      // proxy buffering, and `retry` sets the reconnect delay.
      raw(`retry: 3000\n: connected\n\n`);

      for (const e of ctx.bus.since(since)) send({ type: "event", ...e });
      unsub = ctx.bus.subscribe(send);
      beat = setInterval(() => raw(`: ping\n\n`), SSE_HEARTBEAT_MS);
      req.signal.addEventListener("abort", () => {
        unsub();
        if (beat) clearInterval(beat);
        try {
          c.close();
        } catch {}
      });
    },
    cancel() {
      unsub();
      if (beat) clearInterval(beat);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
};

// ---------------------------------------------------------------------- router


/**
 * A project's own knobs: what it gates on, how it installs, what its sandboxes
 * look like. Merged into `config_json` key by key, so a page that only knows
 * about gates cannot blank the sandbox block on save.
 */




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


