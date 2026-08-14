import type { SandboxDriver } from "../src/mech/sandbox.ts";

/**
 * A sandbox that is just a map.
 *
 * Unit tests have no container to talk to, and the real driver must not paper
 * over that — a connection error has to be an error, or the day the server is
 * down every group quietly does nothing. So the driver is injected on `Ctx`,
 * exactly like `git` and `gh`, and this is what tests inject.
 *
 * `commands` records what was asked for, which is usually the assertion.
 */
export function fakeSandbox(
  handle: (cmd: string) => { code?: number; out?: string; err?: string } = () => ({}),
): SandboxDriver & { commands: string[]; files: Map<string, string> } {
  const commands: string[] = [];
  const files = new Map<string, string>();
  const run = (cmd: string) => {
    commands.push(cmd);
    const r = handle(cmd);
    return { code: r.code ?? 0, out: r.out ?? "", err: r.err ?? "" };
  };
  return {
    commands,
    files,
    exec: async (_ctx, _scope, cmd) => {
      const r = run(cmd);
      // `git bundle create <path> …` has to leave something behind, or every
      // caller that reads the bundle back reports it as missing.
      const bundle = /git bundle create '([^']+)'/.exec(cmd);
      if (bundle && r.code === 0) files.set(bundle[1]!, "PACK");
      return r;
    },
    lines: async function* (_ctx, _scope, cmd) {
      const r = run(cmd);
      for (const l of r.out.split("\n").filter(Boolean)) yield l;
      return { code: r.code, err: r.err };
    },
    put: async (_ctx, _scope, path, data) => {
      files.set(path, data);
    },
    get: async (_ctx, _scope, path) => files.get(path) ?? null,
    getBytes: async (_ctx, _scope, path) => {
      const v = files.get(path);
      return v === undefined ? null : new TextEncoder().encode(v);
    },
    bind: async () => {},
    kill: async () => {},
    renew: async () => {},
  };
}
