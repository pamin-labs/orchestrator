# 039 The flow asks for a capability, never a role name

**Status**: accepted
**Date**: 2026-08-20

`src/platform/config/load.ts` said, in a comment at the top of the file, that
adding a Composer was one yaml file and no code change. It was not: forty-odd
role-name literals were spread through the flow — `review.ts` ×8, `chain.ts` ×7,
`watchdog.ts` ×3, `invariants.ts` ×4, `scheduler.ts` ×4, and the panel — so a new
role meant editing dozens of call sites and finding them by grep.

## The decision

`roles/*.yaml` declares `capabilities:`. The flow names the capability it needs
and `roleWith(roles, cap)` resolves it. Ten capabilities today, one per role:
`write_code`, `review_slice`, `lead_group`, `cut_boundary`, `plan_requirement`,
`triage_boss_feedback`, `compress_context`, `write_pr_message`, `audit_branch`,
`bootstrap_env`.

**Nought or two is an error, not a default.** `roleWith` throws by name in both
directions, and `checkCapabilities` runs all ten at boot rather than at the first
dispatch — a capability nobody claims should stop the server, not a turn at 3am.
The two-role message sorts the names, so it does not depend on `readdir` order,
which is the thing this whole change exists to stop letting decide anything.

## What the guard is

A fixture role `composer`, a name that appears nowhere in `src/`, claiming
`review_slice`. `handToQa` must dispatch to it with no code change. Shown failing
first: `Expected: "composer", Received: "qa"`.

## What stayed a literal, and why

- The `gates_json` `"qa"` key — a stored config key, not a dispatch. Renaming it
  is a migration, not a lookup.
- The escalation chain states in `src/contracts/states.ts` — the chain is an
  ordered ladder with its own vocabulary; a capability would say less than the
  state name does.
- `PLANNING_ROLES` in `scheduler.ts` — a DRAFT-freeze list. A role missing from it
  is dispatched rather than frozen, which is the safe direction; resolving it by
  capability would make an unclaimed capability freeze the group instead.

**Consequence**: `roles/` is a real registry. A role file with no `capabilities:`
loads and is dispatchable by name from the database; it just cannot be the answer
to a capability question.
