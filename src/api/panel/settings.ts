import { currentFor, defaultFor, overrides, putSetting, settablePaths } from "../../settings.ts";
import { z } from "zod";
import { bad, json, message, type Handler } from "../shared.ts";
import { ConfigSchema, SettingWriteSchema, type SettingPath, type SettingValue } from "../../config-schema.ts";
import type { Config } from "../../config.ts";
import type { Json } from "../../contracts/json.ts";

type SettingRowFor<P extends SettingPath> = {
  path: P;
  type: string;
  value: SettingValue<P>;
  default: SettingValue<P>;
  overridden: boolean;
};

/**
 * The settings the boss changes while the fleet is running.
 *
 * One route to read them all and one to write one. There is no save button on
 * the other end: a field is written when it loses focus, which is why the write
 * takes a single path rather than a document — two panes open at once must not
 * be able to overwrite each other's field with a stale copy of it.
 */

/** Everything the panel needs to draw the page: value, default, and whether it was changed. */
export const getSettings = (async (ctx) => {
  const set = overrides(ctx.db);
  const cfg = ConfigSchema.parse(ctx.config);
  return json({
    settings: [...settablePaths()].map(([path, type]) => settingRow(cfg, set, path, type)),
  });
}) satisfies Handler;

/** One path and its path-specific value, inferred and checked from ConfigSchema. */
export const SettingBody = SettingWriteSchema;

export const postSetting = (async (ctx, _req, _p, b) => {
  const cfg = ConfigSchema.parse(ctx.config);
  const why = putSetting(ctx.db, cfg, b.path, b.value);
  if (why) return bad(why);
  Object.assign(ctx.config, cfg);
  ctx.bus.emit({
    author: "boss",
    kind: "state_change",
    body: `设置：${b.path} = ${b.value === null ? "恢复默认" : JSON.stringify(b.value)}`,
    meta: { setting: b.path },
  });
  // Some of these change what may be dispatched right now — raising `maxGroups`
  // is only a number until something looks at the queue again.
  ctx.sched.tick();
  return message("ok");
}) satisfies Handler<z.infer<typeof SettingBody>>;

function settingRow<P extends SettingPath>(
  cfg: Config,
  set: Record<string, Json>,
  path: P,
  type: string,
): SettingRowFor<P> {
  return { path, type, value: currentFor(cfg, path), default: defaultFor(path), overridden: path in set };
}
