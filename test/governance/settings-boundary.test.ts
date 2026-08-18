import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("credential UI owns the login flows while the settings shell owns polling", () => {
  const shell = read("../../web/src/features/settings/view.tsx");
  const pane = read("../../web/src/features/settings/credentials.tsx");

  // Login completion is a dialog concern: it coordinates the query cache and the
  // five-minute deadline across panes. The account component only starts a flow.
  expect(shell).toContain('queryKey: ["auth"]');
  expect(shell).toContain("refetchInterval: signin ? 2000 : false");
  expect(shell).toContain("Date.now() + 300_000");
  expect(shell).toContain("<CredPane");
  expect(pane).not.toContain("useQuery");
  expect(pane).not.toContain("300_000");

  // One implementation, not an extracted copy left beside the original. The
  // endpoints and field IDs move with the account UI that owns their controls.
  expect(shell).not.toContain("function Credential(");
  expect(shell).not.toContain("id={`${r.key}-secret`}");
  expect(pane).toMatch(/id=\{`\$\{[^}]+\.key\}-secret`\}/);
  expect(pane).toMatch(/id=\{`\$\{[^}]+\.key\}-url`\}/);
  for (const contract of ["api.auth.claude.login.code.$post", "api.auth.codex.device.cancel.$post"]) {
    expect(pane).toContain(contract);
  }
});

test("GitHub controls own their flow while the settings shell owns polling", () => {
  const shell = read("../../web/src/features/settings/view.tsx");
  const pane = read("../../web/src/features/settings/github.tsx");

  // The shell keeps the query mounted only for this section and coordinates the
  // device-flow timer. The pane starts actions and asks for one cache refresh.
  expect(shell).toContain('queryKey: ["gh"]');
  expect(shell).toContain('enabled: open && section === "github"');
  expect(shell).toContain("q.state.data?.pending ? 3000 : false");
  expect(shell).toContain("<GithubPane");
  expect(pane).not.toContain("useQuery");
  expect(pane).not.toContain('queryKey: ["gh"]');

  expect(shell).not.toContain("function GithubPane(");
  for (const contract of [
    "api.auth.github.$post",
    'runtime: "github", clear: true',
    'id="t-signoff"',
    'id="t-coauthor"',
  ]) {
    expect(pane).toContain(contract);
  }
});

test("environment controls own actions while the settings shell owns server queries", () => {
  const shell = read("../../web/src/features/settings/view.tsx");
  const pane = read("../../web/src/features/settings/environment.tsx");

  for (const key of ["sandbox-server", "sandbox-images"]) {
    expect(shell).toContain(`queryKey: ["${key}"]`);
    expect(pane).not.toContain(`queryKey: ["${key}"]`);
  }
  // The gate itself, not the line it is written on. Asserting
  // `enabled: open && section === "server"` pinned one spelling, and the shell
  // had to keep a duplicate copy of the expression next to the `const` that
  // already held it — a test dictating shape for no behavioural reason. What
  // matters is that the gate exists and that every sandbox query carries one,
  // or the dialog polls the host while closed or showing another section.
  const GATE = 'open && section === "server"';
  expect(shell).toContain(`const enabled = ${GATE};`);
  // Both sandbox queries, each carrying that gate — shorthand or spelled out.
  // Checking only that an `enabled` key exists would pass `enabled: true`, which
  // is the exact failure this guards against.
  const gates = [...shell.matchAll(/queryKey: \["sandbox-[a-z]+"\][\s\S]{0,200}?enabled(,|: ([^,\n]+),)/g)];
  expect(gates).toHaveLength(2);
  for (const match of gates) expect(match[2] ?? GATE).toBe(GATE);
  expect(shell).toContain("<EnvPane");
  expect(shell).toContain("<ServerPane");
  expect(pane).not.toContain("useQuery");

  expect(shell).not.toContain("function ServerPane(");
  for (const contract of [
    'api["sandbox-server"].restart.$post',
    'api["sandbox-server"].start.$post',
    'api["sandbox-server"].addr.$post',
    'id="sandbox-key"',
  ]) {
    expect(pane).toContain(contract);
  }
});

test("project controls own panes while the settings shell owns project scope", () => {
  const shell = read("../../web/src/features/settings/view.tsx");
  const pane = read("../../web/src/features/settings/project.tsx");

  expect(shell).toContain('queryKey: ["project", projectId, "config"]');
  expect(shell).toContain('api.project[":id"].config.$post');
  expect(shell).toContain("<ProjectPane");
  expect(pane).not.toContain("useQuery");
  expect(pane).not.toContain('queryKey: ["project"');

  expect(shell).not.toContain("function Remove(");
  for (const contract of [
    'section === "gates"',
    'section === "sandbox"',
    'api.projects[":id"].$delete',
    '<Button variant="danger"',
  ]) {
    expect(pane).toContain(contract);
  }
});

/**
 * A setting has one control, in one pane.
 *
 * `sandbox.server` and `sandbox.image` had two each: a generic knob row in the
 * 沙盒默认值 section *and* a purpose-built row in 沙盒服务器 — an address row that
 * validates, and an image row that lists what the registry actually holds.
 * Neither section knew about the other, and the panes were five apart in the
 * sidebar, so which control a reader found was down to which pane they opened.
 * The report that arrived was "the image dropdown disappeared": it had not, they
 * were on the knob.
 *
 * Derived rather than listed, so it holds for the next one too. `putSetting` is
 * the only way a setting is stored, and there are exactly two kinds of caller:
 * the generic endpoint, whose path comes from the request, and a route that names
 * one path — which is what having a purpose-built control means. Those paths must
 * not also be knob rows.
 */
const settingPaths = (): string[] => {
  const out: string[] = [];
  for (const rel of ["src/mech/sandbox/images.ts", "src/mech/sandbox/server.ts", "src/api/panel/settings.ts"]) {
    const src = read(`../../${rel}`);
    for (const call of src.matchAll(/putSetting\(([^)]*)\)/g)) {
      const arg = call[1]!.split(",")[2]?.trim() ?? "";
      // A literal names its path; a bare identifier is either the request's own
      // (the generic endpoint) or a constant in the same file.
      const literal = /^"([\w.]+)"$/.exec(arg);
      if (literal) {
        out.push(literal[1]!);
        continue;
      }
      const named = new RegExp(`const ${arg} = "([\\w.]+)"`).exec(src);
      if (named) out.push(named[1]!);
    }
  }
  return out;
};

/** Every path each knob section says it renders, section by section. */
const knobPaths = (): Map<string, string[]> => {
  const src = read("../../web/src/features/knobs/view.tsx");
  const table = src.slice(src.indexOf("const SECTIONS"), src.indexOf("\n};", src.indexOf("const SECTIONS")));
  const out = new Map<string, string[]>();
  for (const m of table.matchAll(/(\w+): \{[\s\S]*?paths: \[([\s\S]*?)\]/g)) {
    out.set(
      m[1]!,
      [...m[2]!.matchAll(/"([\w.]+)"/g)].map((x) => x[1]!),
    );
  }
  return out;
};

test("a setting written by a route of its own is not also a knob row", () => {
  const bespoke = settingPaths();
  // Non-empty, or this holds by finding nothing. Two routes name a path today.
  expect(bespoke.length).toBeGreaterThanOrEqual(2);
  const knobs = [...knobPaths().values()].flat();
  expect(knobs.length).toBeGreaterThan(10);
  expect(knobs.filter((p) => bespoke.includes(p))).toEqual([]);
});

test("no knob path is rendered by two sections", () => {
  const seen = new Map<string, string[]>();
  for (const [section, paths] of knobPaths()) {
    for (const path of paths) seen.set(path, [...(seen.get(path) ?? []), section]);
  }
  expect([...seen].filter(([, sections]) => sections.length > 1)).toEqual([]);
});
