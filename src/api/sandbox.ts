import { allowedImage, remoteInClear, restartServer, runningServer, serverAddr, skillMounts, specFor } from "../mech/sandbox/sandbox.ts";
import { sandboxLines } from "../mech/sandbox/sandboxlog.ts";
import { imageChoices, setDefaultImage, type ImageChoices } from "../mech/sandbox/images.ts";
import type { Config } from "../config.ts";
import { driftingPaths, ensureServer, inspectServer, ourArgv, serverLogPath, serverLogTail, setServerAddr } from "../mech/sandbox/server.ts";
import { resetServerRestarts } from "../mech/ops/watchdog.ts";
import { preflight } from "../mech/ops/preflight.ts";
import { bad, body, json, text, type Handler } from "./shared.ts";

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
export const getSandbox: Handler = async (ctx, req) => {
  const grpId = Number(new URL(req.url).searchParams.get("grp") ?? 0);
  const grp = ctx.db
    .query<
      { id: number; name: string; status: string; project_id: number; sandbox_id: string | null; sandbox_at: number | null; branch: string | null },
      [number]
    >("SELECT id, name, status, project_id, sandbox_id, sandbox_at, branch FROM grp WHERE id = ?")
    .get(grpId);
  if (!grp) return text("no such group", 404);
  const spec = specFor(ctx, grp.project_id);
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
};

export const getPreflight: Handler = async (ctx) =>
  json({
    checks: await preflight({
      db: ctx.db,
      sandbox: ctx.config.sandbox ?? { server: "127.0.0.1:8080", apiKey: "", image: "" },
      skillsDir: ctx.config.skillsDir,
    }),
  });

/**
 * What the image field may be set to. Two lists, never a text box.
 *
 * Cached for a minute: the remote half is two round trips to ghcr.io and the
 * local half shells out to docker, and the settings dialog asks on every open.
 */
let imageCache: { at: number; v: ImageChoices } | null = null;
export const getImages: Handler = async (ctx) => {
  if (!imageCache || Date.now() - imageCache.at > 60_000) {
    imageCache = { at: Date.now(), v: await imageChoices() };
  }
  // Which one a project gets when it says nothing. Registering a repository
  // sets no image at all, so this is what the fleet actually runs on.
  return json({ ...imageCache.v, current: ctx.config.sandbox?.image ?? "" });
};

export const postImage: Handler = async (ctx, req) => {
  const b = await body<{ image?: string }>(req);
  const image = (b.image ?? "").trim();
  // The same rule the container build applies, applied where the boss can read
  // it. Without this the refusal arrives as a container that will not create.
  if (image && !allowedImage(image)) return bad(`${image} 不是我们发布的镜像，也不是本机构建的`);
  const why = setDefaultImage(ctx.db, ctx.config as Config, image);
  if (why) return bad(why);
  return text("ok");
};

/**
 * The process that hands out containers, and what a restart of it would cost.
 *
 * Whether it is *healthy* is preflight's answer and stays preflight's answer —
 * two things saying "is it up" that can disagree is worse than one that is
 * occasionally stale. This is only what preflight cannot know: the pid, the
 * argv it was started with, and therefore whether there is anything to restart
 * it *with*. `runningServer` learns the argv by seeing the process, so an
 * orchestrator that booted while the server was already down has never seen one
 * and the button has to be dead rather than hopeful.
 *
 * The two counts are the evidence for that button (硬约束 5): a restart kills
 * every container and every turn inside them.
 */
export const getSandboxServer: Handler = async (ctx) => {
  const live = runningServer();
  const count = (sql: string) => ctx.db.query<{ c: number }, []>(sql).get()!.c;
  // Inspect, never ensure. Which of the cases this is decides which button the
  // panel may show — and a GET that starts a process is a page that changes the
  // machine by being looked at.
  const state = await inspectServer(ctx);
  const drift = driftingPaths(ctx);
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
    restartable: !!ourArgv(ctx),
    // The silent one: a mount of a path missing from `allowed_host_paths`
    // succeeds and delivers an empty directory.
    drift,
    // Its own last words, when there are any. Shown rather than summarised: the
    // reason a start fails is almost always in here verbatim.
    log: state.kind === "down" ? serverLogTail(ctx, 8) : "",
    containers: count("SELECT count(*) AS c FROM grp WHERE sandbox_id IS NOT NULL"),
    runningTurns: count("SELECT count(*) AS c FROM job WHERE state = 'running'"),
  });
};

export const postSandboxServerRestart: Handler = async (ctx) => {
  // `ourArgv`, not `runningServer().argv`. The panel only offers this when the
  // server is one we started; this is the same rule enforced where it matters,
  // because a request can arrive from anywhere and "restart" here means killing
  // a machine-wide process that may be somebody's own.
  const argv = ourArgv(ctx);
  if (!argv) {
    return bad(
      "这个沙盒服务器不是我们起的，不会去动它 —— 它可能是你自己起的，配的是别的东西。要重启就自己重启，之后这里会认得它。",
    );
  }
  const err = await restartServer(argv, serverLogPath(ctx));
  // A deliberate restart clears the automatic counter, or the boss restarts by
  // hand, it does not take, and the watchdog has already spent its three tries
  // on the same problem.
  resetServerRestarts();
  if (err) return bad(err);
  ctx.bus.emit({ author: "orchestrator", kind: "state_change", body: "沙盒服务器重启了，容器都没了" });
  return json({ ok: true });
};

/** Point us at another server. The way out of "that one is not ours". */
export const postSandboxServerAddr: Handler = async (ctx, req) => {
  const b = await body<{ addr?: string }>(req);
  const addr = (b.addr ?? "").trim();
  // `host:port`, or empty to fall back to the yaml. Checked because a bad value
  // here makes every container call fail somewhere far away from this box.
  // A hostname and an optional scheme, because the server does not have to be on
  // this machine: a Tailscale peer or a cloud box works the same way.
  if (addr && !/^(https?:\/\/)?[\w.-]+(:\d{2,5})?$/.test(addr)) {
    return bad("填 host:port，或者 https://host:port。比如 127.0.0.1:8081、sandbox.tail1234.ts.net:8080");
  }
  setServerAddr(ctx, addr);
  return json({ ok: true, addr: serverAddr(ctx) });
};

/** Start one when there is none. The panel's way out of the `down` state. */
export const postSandboxServerStart: Handler = async (ctx) => {
  const st = await ensureServer(ctx);
  if (st.kind === "down") return bad(st.why);
  ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    body: st.kind === "started" ? `沙盒服务器起好了（pid ${st.pid}）` : "沙盒服务器本来就在跑，直接用了",
  });
  return json({ ok: true, state: st.kind });
};
