import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("credential UI owns the login flows while the settings shell owns polling", () => {
  const shell = read("../web/src/views/settings.tsx");
  const pane = read("../web/src/views/settings/credentials.tsx");

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
  const shell = read("../web/src/views/settings.tsx");
  const pane = read("../web/src/views/settings/github.tsx");

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
  const shell = read("../web/src/views/settings.tsx");
  const pane = read("../web/src/views/settings/environment.tsx");

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
  const shell = read("../web/src/views/settings.tsx");
  const pane = read("../web/src/views/settings/project.tsx");

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
