# 008 A passed audit says a branch *may* be published, not what it is published as

**Status**: implemented. `roles/scribe.yaml`, `orch pr`, `checkPrMessage`,
`ctx.publishBranch`, PR_OPEN's repair in `invariants.ts`.

Every pull request this project has opened was titled `orch: <group name>` — the
Dispatcher's slug for the requirement, chosen before a diff exists, so four PRs
in one release carried the same shape and `--generate-notes` filed all four under
"other". The commit was worse: `openPr` squashed with the whole PR body, so `##
Slices (3, all accepted)` and a gate table went into `git log`, in somebody
else's repository, in the place that outlives the review page it was written for.

**Why an agent and not a template.** Every input a template can reach is a
statement of intent — the card said what to build, the slices said what to
accept. A log entry has to say what the change turned out to be, and the only
place that exists is the diff.

**Why not the Auditor**, which already reads the branch: its prompt is three
questions and an instruction not to do anything else, and an audit can fail —
asking for a title on every audit spends tokens on the branches going back for
rework.

**The shape.** One turn, in the group's own sandbox (unlike the Auditor, which
sits outside deliberately — the Scribe is summarising, not reviewing, and the
branch is checked out there). Cheapest tier, no `Edit`/`Write`: a stronger model
writes a longer subject, not a better one, and a Scribe that can touch a file can
invalidate the review that just approved the branch. `checkPrMessage` is the
convention as an `if`, and `scribe.yaml` states its five refusals by name (硬约束
6). The commit gets the Scribe's message; the PR gets it plus the record below,
still assembled from the database — paying a model to restate a `SELECT` is
paying for a query.

**Consequence, and the hole it opened.** Publishing moved off the audit, so a
group can sit PR_OPEN holding a place in a strictly serial merge queue with no PR
number — everything behind it stopped, and it looks healthy. PR_OPEN's repair is
the driver (硬约束 7): audited, queued, no number, nothing left to run, publish
with the fallback. `merge_seq IS NOT NULL` is what makes that query safe — a
group is PR_OPEN from the branch gate onward, which is before the audit.

`orch: <group name>` survives as that fallback, now the mark of a message nobody
wrote rather than the normal case.
