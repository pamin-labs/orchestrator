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
  expect(shell).not.toContain('id={`${r.key}-secret`}');
  for (const contract of [
    'id={`${r.key}-secret`}',
    'id={`${r.key}-url`}',
    '"/api/auth/claude/login/code"',
    '"/api/auth/codex/device/cancel"',
  ]) {
    expect(pane).toContain(contract);
  }
});
