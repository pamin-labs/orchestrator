import { expect, test } from "bun:test";
import { openMemory } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { applyOverrides, defaultFor, overrides, putSetting, refuse, settablePaths } from "../src/settings.ts";

test("the settable paths are the config's own, and nothing else is", () => {
  const paths = settablePaths();
  // Ordinary knobs, nested ones, and the open maps that are a value rather than
  // a branch — `contextWindow` is keyed by model id, so its keys are data.
  expect(paths.get("maxGroups")).toBe("number");
  expect(paths.get("autoAdvance")).toBe("boolean");
  expect(paths.get("autoAcceptTiers")).toBe("array");
  expect(paths.get("sandbox.memory")).toBe("string");
  expect(paths.get("contextWindow")).toBe("object");
  expect(paths.has("contextWindow.claude-opus-5")).toBe(false);

  // Where the server listens cannot be set from a page the server is serving,
  // and the database path cannot live in the database.
  for (const p of ["host", "port", "dataDir", "sandbox.apiKey"]) {
    expect(paths.has(p)).toBe(false);
    expect(refuse(p, 1)).toBeTruthy();
  }
  expect(refuse("nonsense", 1)).toBe("no setting called nonsense");
  expect(refuse("maxGroups", "ten")).toBe("maxGroups is a number, not a string");
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
  expect(putSetting(db, cfg, "port", 1)).toBeTruthy();
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
  expect(fresh.maxGroups).toBe(defaultFor("maxGroups") as number);
});
