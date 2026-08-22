import { expect, test } from "bun:test";
import { prUrl } from "../../web/src/shared/select";
import { repoHref } from "../../web/src/shared/github";
import type { Group, Project, Snapshot } from "../../src/contracts/panel.ts";

const state = (remote: string): Snapshot => ({
  ready: true,
  failing: [],
  projects: [{ id: 1, name: "p", repo_path: "o/n", remote, base_branch: null } satisfies Project],
  groups: [],
  slices: [],
  tasks: [],
  agents: [],
  escalations: [],
  channels: [],
  draftCards: [],
  lateObjections: [],
  approvedBlocked: [],
  dropProposals: [],
  ideas: [],
  answered: [],
  mergeQueue: [],
  archived: [],
  usage: [],
  limits: { maxGroups: null, leaseSlots: {}, autoAdvance: false, autoAcceptTiers: [] },
  lastSeq: 0,
});

const group = (prNumber: number | null): Group => ({
  id: 7,
  project_id: 1,
  name: "g",
  branch: null,
  status: "PR_OPEN",
  owns_json: [],
  budget_tokens: null,
  spent_tokens: 0,
  pr_number: prNumber,
  approved_at: null,
});

test("a pull request link is built from the remote, in every shape a remote is written", () => {
  const url = (remote: string) => prUrl(state(remote), group(12));
  expect(url("https://github.com/acme/tool.git")).toBe("https://github.com/acme/tool/pull/12");
  expect(url("https://github.com/acme/tool")).toBe("https://github.com/acme/tool/pull/12");
  expect(url("git@github.com:acme/tool.git")).toBe("https://github.com/acme/tool/pull/12");
  expect(url("ssh://git@github.com/acme/tool.git")).toBe("https://github.com/acme/tool/pull/12");
});

test("a link is only built from a repository this actually names", () => {
  // The name segment used to be `(.+?)`, which matches slashes. This produced
  // `https://github.com/o/n/../../x/pull/12` — a link the panel presented as
  // "go and merge it" that resolved somewhere else entirely. The scheme and
  // host were always literal, so nothing could leave github.com; what it could
  // do is point at the wrong repository under it.
  const url = (remote: string) => prUrl(state(remote), group(12));
  expect(url("https://github.com/acme/tool/../../evil")).toBeNull();
  expect(url("https://github.com/acme/tool/tree/main")).toBeNull();
  expect(url("https://gitlab.com/acme/tool.git")).toBeNull();
  expect(url("")).toBeNull();
  // No pull request number is not a link either, however good the remote is.
  expect(prUrl(state("https://github.com/acme/tool"), group(null))).toBeNull();
});

test("a repository link holds the same shape, including the row a migration could not convert", () => {
  expect(repoHref("acme/tool")).toBe("https://github.com/acme/tool");
  expect(repoHref("/Users/someone/code/tool")).toBeNull();
  expect(repoHref("acme/tool/../../evil")).toBeNull();
  expect(repoHref(null)).toBeNull();
  expect(repoHref("")).toBeNull();
});
