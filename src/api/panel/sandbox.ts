import { msg } from "@lingui/core/macro";
import { count, eq, isNotNull } from "drizzle-orm";
import {
  allowedImage,
  remoteInClear,
  restartServer,
  runningServer,
  serverAddr,
  skillMounts,
  specFor,
} from "../../mech/sandbox/sandbox.ts";
import { sandboxLines } from "../../mech/sandbox/sandboxlog.ts";
import { imageChoices, setDefaultImage, type ImageChoices } from "../../mech/sandbox/images.ts";
import {
  driftingPaths,
  ensureServer,
  inspectServer,
  ourArgv,
  serverLogPath,
  serverLogTail,
  setServerAddr,
} from "../../mech/sandbox/server.ts";
import { resetServerRestarts } from "../../mech/ops/watchdog.ts";
import { preflight } from "../../mech/ops/preflight.ts";
import { z } from "zod";
import type { Handler } from "../../http/handler.ts";
import { bad, badEnglish, json, message } from "../../http/respond.ts";
import { grp as grps, job } from "../../platform/persistence/schema.ts";

/**
 * What this machine can and cannot do, and the sidecar that decides it.
 *
 * Read-only checks plus the four buttons that act on the sandbox server. They
 * answer one question the boss asks in one moment — "why can nothing start" —
 * and answering it in four places is how a panel ends up reporting an absence
 * four different ways.
 */

/**
 * One group's container: what it is, and what it has been saying.
 *
 * The lines are in memory and capped (`sandboxlog.ts`) — this is the machine
 * setting itself up, which is worth watching and scrolling back through, not
 * worth a table. The panel says so rather than pretending the log is durable.
 */
export const SandboxQuery = z.object({ grp: z.coerce.number().int().positive() });

export const getSandbox = (async (ctx, _req, _params, { grp: grpId }) => {
  const [grp] = await ctx.db
    .select({
      id: grps.id,
      name: grps.name,
      status: grps.status,
      project_id: grps.project_id,
      sandbox_id: grps.sandbox_id,
      sandbox_at: grps.sandbox_at,
      branch: grps.branch,
    })
    .from(grps)
    .where(eq(grps.id, grpId));
  if (!grp) return message("no such group", 404);
  const spec = await specFor(ctx, grp.project_id);
  return json({
    group: { id: grp.id, name: grp.name, status: grp.status, branch: grp.branch },
    sandbox: {
      id: grp.sandbox_id,
      at: grp.sandbox_at,
      image: spec.image,
      cpu: spec.cpu,
      memory: spec.memory,
      ttlSeconds: spec.ttlSeconds,
      mounts: [
        ...Object.entries(spec.cacheDirs).map(([mountPath, hostPath]) => ({ mountPath, hostPath, readOnly: false })),
        ...skillMounts(ctx).map((m) => ({ mountPath: m.mountPath, hostPath: m.host?.path ?? "", readOnly: true })),
      ],
    },
    lines: sandboxLines(grpId),
  });
}) satisfies Handler<z.infer<typeof SandboxQuery>>;

/**
 * Run the checks now, and publish what they found.
 *
 * Through `ctx.recheck` rather than calling `preflight` here: this runs when the
 * boss has just fixed something, and a private copy left the pane green while
 * the shell's banner still quoted the answer the readiness timer last found.
 * The direct call stays as the fallback for a context with no server behind it.
 */
export const getPreflight = (async (ctx) =>
  json({
    // Copied out of the readonly view the owner hands back: the wire type is the
    // panel's, and making it readonly would push `ReadonlyArray` through every
    // pane that renders a check.
    checks: [
      ...(await (ctx.recheck?.() ??
        preflight({
          db: ctx.db,
          sandbox: ctx.config.sandbox,
          skillsDir: ctx.config.skillsDir,
          cfg: ctx.config,
        }))),
    ],
  })) satisfies Handler;

/**
 * What the image field may be set to. Two lists, never a text box.
 *
 * Cached for a minute: the remote half is two round trips to ghcr.io and the
 * local half shells out to docker, and the settings dialog asks on every open.
 */
let imageCache: { at: number; v: ImageChoices } | null = null;
export const getImages = (async (ctx) => {
  if (!imageCache || Date.now() - imageCache.at > 60_000) {
    imageCache = { at: Date.now(), v: await imageChoices() };
  }
  // Which one a project gets when it says nothing. Registering a repository
  // sets no image at all, so this is what the fleet actually runs on.
  return json({ ...imageCache.v, current: ctx.config.sandbox.image });
}) satisfies Handler;

/** Empty clears the machine's default back to whatever ships. */
export const ImageBody = z.object({ image: z.string().max(300).default("") });

export const postImage = (async (ctx, _req, _p, b) => {
  const image = b.image.trim();
  // The same rule the container build applies, applied where the boss can read
  // it. Without this the refusal arrives as a container that will not create.
  if (image && !allowedImage(image))
    return badEnglish(`${image} is neither an image we publish nor one built on this machine`);
  const why = await setDefaultImage(ctx.db, ctx.config, image);
  if (why) return badEnglish(why);
  return message("ok");
}) satisfies Handler<z.infer<typeof ImageBody>>;

/**
 * The process that hands out containers, and what a restart of it would cost.
 *
 * Whether it is *healthy* is preflight's answer and stays preflight's — two things
 * saying "is it up" that can disagree is worse than one that is occasionally stale.
 * This is only what preflight cannot know: the pid, the argv it was started with,
 * and therefore whether there is anything to restart it *with*.
 */
/**
 * `runningServer` learns the argv by seeing the process, so an orchestrator that
 * booted while the server was already down has never seen one and the button has to
 * be dead rather than hopeful. The two counts are the evidence for that button: a
 * restart kills every container and every turn inside them.
 */
export const getSandboxServer = (async (ctx) => {
  const live = runningServer();
  // Inspect, never ensure. Which of the cases this is decides which button the
  // panel may show — and a GET that starts a process is a page that changes the
  // machine by being looked at.
  const state = await inspectServer(ctx);
  const drift = await driftingPaths(ctx);
  const [containers] = await ctx.db.select({ c: count() }).from(grps).where(isNotNull(grps.sandbox_id));
  const [runningTurns] = await ctx.db.select({ c: count() }).from(job).where(eq(job.state, "running"));
  return json({
    running: state.kind !== "down",
    addr: serverAddr(ctx),
    // Plain HTTP to a host that is neither loopback nor an encrypted overlay.
    inClear: remoteInClear(serverAddr(ctx)),
    state: state.kind,
    why: "why" in state ? state.why : null,
    pid: "pid" in state ? state.pid : (live?.pid ?? null),
    config: state.kind === "started" ? state.config : (live?.config ?? null),
    argv: live?.argv ?? [],
    // Ours only. Restarting a server we did not start takes down whatever else
    // on this machine was using it, and nothing here can see what that was.
    restartable: !!(await ourArgv(ctx.db)),
    // The silent one: a mount of a path missing from `allowed_host_paths`
    // succeeds and delivers an empty directory.
    drift,
    // Its own last words, when there are any. Shown rather than summarised: the
    // reason a start fails is almost always in here verbatim.
    log: state.kind === "down" ? serverLogTail(ctx, 8) : "",
    containers: containers?.c ?? 0,
    runningTurns: runningTurns?.c ?? 0,
  });
}) satisfies Handler;

export const postSandboxServerRestart = (async (ctx) => {
  // `ourArgv`, not `runningServer().argv`. The panel only offers this when the
  // server is one we started; this is the same rule enforced where it matters,
  // because a request can arrive from anywhere and "restart" here means killing
  // a machine-wide process that may be somebody's own.
  const argv = await ourArgv(ctx.db);
  if (!argv) {
    return bad(
      msg`We did not start this sandbox server, so we will not touch it — it may be your own, configured for something else. Restart it yourself and this page will recognise it afterwards.`,
    );
  }
  const err = await restartServer(argv, serverLogPath(ctx));
  // A deliberate restart clears the automatic counter, or the boss restarts by
  // hand, it does not take, and the watchdog has already spent its three tries
  // on the same problem.
  resetServerRestarts();
  if (err) return badEnglish(err);
  await ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    say: msg`the sandbox server was restarted, so every container it held is gone`,
  });
  return json({ ok: true });
}) satisfies Handler;

/** Point us at another server. The way out of "that one is not ours". */
export const AddrBody = z.object({ addr: z.string().max(300).default("") });

export const postSandboxServerAddr = (async (ctx, _req, _p, b) => {
  const addr = b.addr.trim();
  // `host:port`, or empty to fall back to the yaml. Checked because a bad value
  // here makes every container call fail somewhere far away from this box.
  // A hostname and an optional scheme, because the server does not have to be on
  // this machine: a Tailscale peer or a cloud box works the same way.
  if (addr && !/^(https?:\/\/)?[\w.-]+(:\d{2,5})?$/.test(addr)) {
    return bad(msg`Use host:port, or https://host:port — for example 127.0.0.1:8081 or sandbox.tail1234.ts.net:8080.`);
  }
  await setServerAddr(ctx, addr);
  return json({ ok: true, addr: serverAddr(ctx) });
}) satisfies Handler<z.infer<typeof AddrBody>>;

/** Start one when there is none. The panel's way out of the `down` state. */
export const postSandboxServerStart = (async (ctx) => {
  const st = await ensureServer(ctx);
  if (st.kind === "down") return badEnglish(st.why);
  await ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    say:
      st.kind === "started"
        ? msg`the sandbox server is up (pid ${{ pid: st.pid }})`
        : msg`the sandbox server was already running, so this used the one that was there`,
  });
  return json({ ok: true, state: st.kind });
}) satisfies Handler;
