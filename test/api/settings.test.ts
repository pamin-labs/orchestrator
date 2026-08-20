import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import * as schema from "../../src/platform/persistence/schema.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import {
  applyOverrides,
  defaultFor,
  overrides,
  putSetting,
  refuse,
  settablePaths,
} from "../../src/platform/config/settings.ts";
import { makeApp } from "../../src/composition/api.ts";
import type { Json } from "../../src/contracts/json.ts";
import { z } from "zod";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

const SettingsResponse = z.object({
  settings: z.array(
    z.object({ path: z.string(), type: z.string(), value: z.json(), default: z.json(), overridden: z.boolean() }),
  ),
});

test("the settable paths are the config's own, and nothing else is", () => {
  const paths = settablePaths();
  // Ordinary knobs, nested ones, and the open maps that are a value rather than
  // a branch — `contextWindow` is keyed by model id, so its keys are data.
  expect(paths.get("maxGroups")).toBe("number");
  expect(paths.get("autoAdvance")).toBe("boolean");
  expect(paths.get("autoAcceptTiers")).toBe("array");
  expect(paths.get("sandbox.memory")).toBe("string");
  expect(paths.get("contextWindow")).toBe("object");
  expect([...paths.keys()]).not.toContain("contextWindow.claude-opus-5");

  // Where the server listens cannot be set from a page the server is serving,
  // and the database path cannot live in the database.
  for (const p of ["host", "port", "dataDir", "sandbox.apiKey"]) {
    expect([...paths.keys()]).not.toContain(p);
    expect(refuse(p, 1)).toBeTruthy();
  }
  expect(refuse("nonsense", 1)).toBe("no setting called nonsense");
  expect(refuse("maxGroups", "ten")).toContain("maxGroups");

  // The hole this schema closed. `busyGroups.size >= maxGroups()` is the
  // scheduler's admission test, so zero means no group turn is ever dispatched
  // again — and the override is persisted, so a restart does not clear it. The
  // yaml checker had this bound; the panel, which walked the *type of the
  // default value*, did not.
  expect(refuse("maxGroups", 0)).toBeTruthy();
  expect(refuse("maxGroups", -1)).toBeTruthy();
  expect(refuse("turnTimeoutMs", 0)).toBeTruthy();
  expect(refuse("watchdogIntervalMs", 0)).toBeTruthy();
  expect(refuse("leaseSlots", { browser: 0 })).toBeTruthy();
  expect(refuse("sessionRotateFraction", 0)).toBeTruthy();
  expect(refuse("sessionRotateFraction", 1)).toBeTruthy();
  // And the values that are meant to work still do, including the two forms
  // `leaseSlots` legitimately takes.
  expect(refuse("maxGroups", 4)).toBeNull();
  expect(refuse("leaseSlots", 2)).toBeNull();
  expect(refuse("leaseSlots", { default: 2, browser: 1 })).toBeNull();
  expect(refuse("gateRetries", 0)).toBeNull();
});

test("a setting takes effect on the live config, not only on the next boot", async () => {
  const db = await openMemory();
  const cfg = loadConfig("config/does-not-exist.yaml");
  const before = cfg.maxGroups;

  // The failure this exists to stop: a row written, a panel that reads back what
  // it just typed, and a fleet still using the old number until someone restarts.
  expect(await putSetting(db, cfg, "maxGroups", 3)).toBeNull();
  expect(cfg.maxGroups).toBe(3);
  expect(await overrides(db)).toEqual({ maxGroups: 3 });

  // Nested, and an open map written whole.
  expect(await putSetting(db, cfg, "sandbox.memory", "16Gi")).toBeNull();
  expect(cfg.sandbox.memory).toBe("16Gi");
  expect(await putSetting(db, cfg, "contextWindow", { "claude-opus-5": 2_000_000 })).toBeNull();
  expect(cfg.contextWindow).toEqual({ "claude-opus-5": 2_000_000 });

  // Clearing goes back to the file's value, both in memory and in the table.
  expect(await putSetting(db, cfg, "maxGroups", null)).toBeNull();
  expect(cfg.maxGroups).toBe(before);
  expect(await overrides(db)).not.toHaveProperty("maxGroups");

  // And a refused write changes neither.
  // @ts-expect-error untyped JavaScript callers still need runtime rejection.
  expect(await putSetting(db, cfg, "port", 1)).toBeTruthy();
  // @ts-expect-error untyped JavaScript callers still need runtime rejection.
  expect(await putSetting(db, cfg, "maxGroups", "lots")).toBeTruthy();
  expect(cfg.maxGroups).toBe(before);
});

test("stored settings are layered over the file at boot, and stale keys are ignored", async () => {
  const db = await openMemory();
  const cfg = loadConfig("config/does-not-exist.yaml");
  await putSetting(db, cfg, "autoAdvance", false);
  await putSetting(db, cfg, "sandbox.ttlSeconds", 3600);

  // A key from a version that had it, and one whose type changed since. Both
  // have to be skipped rather than thrown on: a settings row must never be able
  // to stop the server from starting.
  const f = fx.on(db);
  await f.setting.create({ k: "cfg.goneAway", v: "1" });
  await f.setting.create({ k: "cfg.maxGroups", v: '"twelve"' });

  const fresh = await applyOverrides(db, loadConfig("config/does-not-exist.yaml"));
  expect(fresh.autoAdvance).toBe(false);
  expect(fresh.sandbox.ttlSeconds).toBe(3600);
  expect(fresh.maxGroups).toBe(defaultFor("maxGroups"));
});

test("the panel reads every knob and writes one at a time", async () => {
  const db = await openMemory();
  const cfg = await applyOverrides(db, loadConfig("config/does-not-exist.yaml"));
  const ctx = await testContext({ db, config: cfg });
  const app = makeApp(ctx);

  const read = async () => {
    const r = await app(new Request("http://x/api/v1/settings"));
    return SettingsResponse.parse(await r.json());
  };
  const write = (body: Json) =>
    app(
      new Request("http://x/api/v1/settings", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      }),
    );

  const before = await read();
  const groups = before.settings.find((s) => s.path === "maxGroups")!;
  expect(groups.value).toBe(cfg.maxGroups);
  expect(groups.overridden).toBe(false);
  // The paths the file keeps are not offered at all, rather than offered and refused.
  expect(before.settings.map((s) => s.path)).not.toContain("port");

  expect((await write({ path: "maxGroups", value: 4 })).status).toBe(200);
  // Both halves: what the next boot will read, and what this process is using
  // right now. A row alone is a knob that changes nothing until tomorrow.
  const after = await read();
  expect(after.settings.find((s) => s.path === "maxGroups")).toMatchObject({ value: 4, overridden: true });
  expect(ctx.config.maxGroups).toBe(4);

  // Refusals come back as JSON the panel can show, not as a 500.
  const no = await write({ path: "port", value: 1 });
  expect(no.status).toBe(400);
  expect(z.object({ error: z.string() }).parse(await no.json()).error).toContain("startup argument");
  expect((await write({ path: "maxGroups", value: "four" })).status).toBe(400);
  expect(ctx.config.maxGroups).toBe(4);
});

test("writing a setting does not edit what the default means", async () => {
  const db = await openMemory();
  const cfg = loadConfig("config/does-not-exist.yaml");
  const shipped = defaultFor("sandbox.image");

  // `defu` fills an absent key by reference, so a config whose whole `sandbox:`
  // block came from the defaults *was* the defaults' block. Writing through it
  // edited `DEFAULTS` for the rest of the process — and the visible symptom
  // would have been the "restore default" button restoring the value it was
  // asked to undo.
  await putSetting(db, cfg, "sandbox.image", "orch/agent:1");
  expect(cfg.sandbox.image).toBe("orch/agent:1");
  expect(defaultFor("sandbox.image")).toBe(shipped);
  expect(loadConfig("config/does-not-exist.yaml").sandbox.image).toBe(shipped);

  // Which is what makes clearing it mean anything.
  await putSetting(db, cfg, "sandbox.image", null);
  expect(cfg.sandbox.image).toBe(shipped);
});

/**
 * A refused setting must not survive the refusal.
 *
 * `embedding.mode` and its endpoint are two fields with one rule between them,
 * and the panel writes the mode the moment the segment is pressed. The write
 * stored the row and *then* validated, so pressing 远程 left
 * `cfg.embedding.mode = "remote"` in the database with no endpoint — and the
 * next boot refused to start on it. The only control that could have corrected
 * the value was in the panel that would not come up.
 */
test("a value the whole config rejects is neither stored nor applied", async () => {
  const db = await openMemory();
  const cfg = loadConfig();
  const before = structuredClone(cfg.embedding);

  const why = await putSetting(db, cfg, "embedding.mode", "remote");

  expect(why).toContain("endpoint");
  // Not stored: a row nobody can apply is a boot this database cannot survive.
  expect(await overrides(db)).toEqual({});
  // Not applied: the fleet reading this object is still on the old value.
  expect(cfg.embedding).toEqual(before);
});

/**
 * The same value arriving from somewhere this process does not control — an
 * older release, a hand-edited row, a restore — is skipped rather than thrown.
 */
test("a stored override that no longer applies is skipped, not fatal", async () => {
  const db = await openMemory();
  const cfg = loadConfig();
  await db.insert(schema.setting).values({ k: "cfg.embedding.mode", v: JSON.stringify("remote") });

  await applyOverrides(db, cfg);

  expect(cfg.embedding.mode).toBe("local");
});
