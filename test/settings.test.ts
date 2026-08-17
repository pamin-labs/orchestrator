import { expect, test } from "bun:test";
import { migrate, migrationMentioning, openMemory } from "../src/platform/persistence/database.ts";
import { loadConfig } from "../src/platform/config/load.ts";
import {
  applyOverrides,
  defaultFor,
  overrides,
  putSetting,
  refuse,
  settablePaths,
} from "../src/platform/config/settings.ts";
import { Bus } from "../src/platform/persistence/event-bus.ts";
import { Scheduler } from "../src/scheduler.ts";
import { makeApp } from "../src/api.ts";
import type { Ctx } from "../src/ctx.ts";
import type { Json } from "../src/contracts/json.ts";
import { z } from "zod";

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

test("a setting takes effect on the live config, not only on the next boot", () => {
  const db = openMemory();
  const cfg = loadConfig("config/does-not-exist.yaml");
  const before = cfg.maxGroups;

  // The failure this exists to stop: a row written, a panel that reads back what
  // it just typed, and a fleet still using the old number until someone restarts.
  expect(putSetting(db, cfg, "maxGroups", 3)).toBeNull();
  expect(cfg.maxGroups).toBe(3);
  expect(overrides(db)).toEqual({ maxGroups: 3 });

  // Nested, and an open map written whole.
  expect(putSetting(db, cfg, "sandbox.memory", "16Gi")).toBeNull();
  expect(cfg.sandbox.memory).toBe("16Gi");
  expect(putSetting(db, cfg, "contextWindow", { "claude-opus-5": 2_000_000 })).toBeNull();
  expect(cfg.contextWindow).toEqual({ "claude-opus-5": 2_000_000 });

  // Clearing goes back to the file's value, both in memory and in the table.
  expect(putSetting(db, cfg, "maxGroups", null)).toBeNull();
  expect(cfg.maxGroups).toBe(before);
  expect(overrides(db)).not.toHaveProperty("maxGroups");

  // And a refused write changes neither.
  // @ts-expect-error untyped JavaScript callers still need runtime rejection.
  expect(putSetting(db, cfg, "port", 1)).toBeTruthy();
  // @ts-expect-error untyped JavaScript callers still need runtime rejection.
  expect(putSetting(db, cfg, "maxGroups", "lots")).toBeTruthy();
  expect(cfg.maxGroups).toBe(before);
});

test("stored settings are layered over the file at boot, and stale keys are ignored", () => {
  const db = openMemory();
  const cfg = loadConfig("config/does-not-exist.yaml");
  putSetting(db, cfg, "autoAdvance", false);
  putSetting(db, cfg, "sandbox.ttlSeconds", 3600);

  // A key from a version that had it, and one whose type changed since. Both
  // have to be skipped rather than thrown on: a settings row must never be able
  // to stop the server from starting.
  db.run("INSERT INTO setting (k, v) VALUES ('cfg.goneAway', '1')");
  db.run("INSERT INTO setting (k, v) VALUES ('cfg.maxGroups', '\"twelve\"')");

  const fresh = applyOverrides(db, loadConfig("config/does-not-exist.yaml"));
  expect(fresh.autoAdvance).toBe(false);
  expect(fresh.sandbox.ttlSeconds).toBe(3600);
  expect(fresh.maxGroups).toBe(defaultFor("maxGroups"));
});

test("the panel reads every knob and writes one at a time", async () => {
  const db = openMemory();
  const bus = new Bus(db);
  const cfg = applyOverrides(db, loadConfig("config/does-not-exist.yaml"));
  const sched = new Scheduler(db, async () => {});
  const ctx: Ctx = { db, bus, sched, waiters: new Map(), config: cfg };
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

test("the two settings that predate the settings table land on it", () => {
  const db = openMemory();
  // What migration 039 finds on an existing install: the panel's own image and
  // address rows, each written by a reader and a writer of its own.
  db.run("INSERT INTO setting (k, v) VALUES ('sandbox_image', 'orch/agent:1')");
  db.run("INSERT INTO setting (k, v) VALUES ('sandbox_server_addr', '10.0.0.4:8080')");
  // `openMemory` has already run every migration, so rewind the stamp for this
  // one and let the runner do it again — the point is what the SQL does to rows
  // that are already there, which a fresh database can never show.
  //
  // Found by content. `max(n)` said "this one" and meant "the newest one", so
  // this test quietly retargeted itself at every migration that came after and
  // then failed on that migration's ALTER TABLE.
  db.run("DELETE FROM migration WHERE n = ?", [migrationMentioning("sandbox_server_addr")]);
  migrate(db);

  // One home per value. Two is a precedence order that lives only in code, and
  // it is the shape that produced `grp.worktree` — a column nothing wrote and
  // four things read.
  expect(overrides(db)).toMatchObject({
    "sandbox.image": "orch/agent:1",
    "sandbox.server": "10.0.0.4:8080",
  });
  expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM setting WHERE k NOT LIKE 'cfg.%'").get()!.c).toBe(0);

  // And they arrive on the config the same way every other override does.
  const cfg = applyOverrides(db, loadConfig("config/does-not-exist.yaml"));
  expect(cfg.sandbox.image).toBe("orch/agent:1");
  expect(cfg.sandbox.server).toBe("10.0.0.4:8080");
});

test("writing a setting does not edit what the default means", () => {
  const db = openMemory();
  const cfg = loadConfig("config/does-not-exist.yaml");
  const shipped = defaultFor("sandbox.image");

  // `defu` fills an absent key by reference, so a config whose whole `sandbox:`
  // block came from the defaults *was* the defaults' block. Writing through it
  // edited `DEFAULTS` for the rest of the process — and the visible symptom
  // would have been the "restore default" button restoring the value it was
  // asked to undo.
  putSetting(db, cfg, "sandbox.image", "orch/agent:1");
  expect(cfg.sandbox.image).toBe("orch/agent:1");
  expect(defaultFor("sandbox.image")).toBe(shipped);
  expect(loadConfig("config/does-not-exist.yaml").sandbox.image).toBe(shipped);

  // Which is what makes clearing it mean anything.
  putSetting(db, cfg, "sandbox.image", null);
  expect(cfg.sandbox.image).toBe(shipped);
});
