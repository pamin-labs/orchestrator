import { defaultFor, overrides, putSetting, settablePaths } from "../../settings.ts";
import { z } from "zod";
import { bad, json, text, type Handler } from "../shared.ts";
import type { Config } from "../../config.ts";

/**
 * The settings the boss changes while the fleet is running.
 *
 * One route to read them all and one to write one. There is no save button on
 * the other end: a field is written when it loses focus, which is why the write
 * takes a single path rather than a document — two panes open at once must not
 * be able to overwrite each other's field with a stale copy of it.
 */

/** Everything the panel needs to draw the page: value, default, and whether it was changed. */
export const getSettings: Handler = async (ctx) => {
  const set = overrides(ctx.db);
  const cfg = ctx.config as Config;
  return json({
    settings: [...settablePaths()].map(([path, type]) => ({
      path,
      type,
      value: at(cfg, path),
      default: defaultFor(path),
      overridden: path in set,
    })),
  });
};

/**
 * One path and its value, never a document.
 *
 * `value` is `unknown` because the type it must be is `DEFAULTS`' — the settings
 * table is the authority on which paths exist and what each one holds, and
 * `putSetting` checks against it. A shape here could only say "anything", twice.
 */
export const SettingBody = z.object({ path: z.string().min(1).max(120), value: z.unknown().optional() });

export const postSetting: Handler<z.infer<typeof SettingBody>> = async (ctx, _req, _p, b) => {
  // `null` clears the override and falls back to the file. Distinguished from
  // "absent" so that clearing is an explicit action rather than an empty body.
  const why = putSetting(ctx.db, ctx.config as Config, b.path, b.value ?? null);
  if (why) return bad(why);
  ctx.bus.emit({
    author: "boss",
    kind: "state_change",
    body: `设置：${b.path} = ${b.value === undefined || b.value === null ? "恢复默认" : JSON.stringify(b.value)}`,
    meta: { setting: b.path },
  });
  // Some of these change what may be dispatched right now — raising `maxGroups`
  // is only a number until something looks at the queue again.
  ctx.sched.tick();
  return text("ok");
};

function at(cfg: Config, path: string): unknown {
  let node: unknown = cfg;
  for (const p of path.split(".")) node = (node as Record<string, unknown>)?.[p];
  return node;
}
