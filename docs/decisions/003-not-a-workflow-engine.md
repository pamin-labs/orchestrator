# 003 — Not a workflow engine (n8n / DAG / LangChain / LangGraph)

**Status**: accepted. Two details are dated by 005 — admission control no longer
has a clearance dimension, and the sandbox is a container rather than the CLI's
own Seatbelt profile. Neither changes the answer.

**Question that keeps coming back**: should the substrate be an AI workflow engine
instead of a job queue plus sqlite?

**Answer: no.** Not a taste call. The control flow this product needs is not a
graph, and the one place a framework would insert itself is the one place we
cannot give up.

## The shape of the control flow is a queue, not a graph

A DAG engine is for a known graph of steps with data on the edges. Here:

- **The graph is written at runtime and rewritten mid-run.** The Dispatcher
  decides how many slices exist. QA sends one back. The boss respecs, parks,
  interrupts, rolls back to a git checkpoint. Every node would need an escape
  edge to every other state, which is a queue plus a state machine drawn badly.
- **Intercept must work at any instant** (PLAN.md §7). That is possible only
  because exactly one serial dispatch point exists. A DAG's equivalent is
  cancelling a run and reconstructing where it was.
- **Admission control is per group and per budget.** Those are checks before
  dequeue, not properties of an edge.

## LangChain / LangGraph want to own the model call, and we want the CLI to

The agent runtime is deliberately `claude -p` / `codex exec` as a subprocess
(PLAN.md §2): per-turn model switch is one flag, a crashed agent cannot take down
the orchestrator, and the CLI's own hooks, skills, `CLAUDE.md` and settings all
keep working inside the container. A framework that wraps the model call throws
that away and gives back nothing this system needs.

**The decisive one: prompt assembly.** Hard constraint #1 is that the injected
delta lands at the end of the newest user message, or the prompt cache is
destroyed and every turn costs 3-5x with no functional symptom. Framework prompt
assembly is exactly where that invariant dies quietly. `src/prompt/assemble.ts`
owns it and `test/cache-position.test.ts` guards it.

## What people actually reach for those tools to get, and where it already lives

| Want | Here |
|---|---|
| Checkpoint / resume | `job` rows + `wip:` git commit per turn + `checkpoint_sha` |
| Durable state | `bun:sqlite` WAL, `event` and `note` append-only |
| Streaming / observability | `--include-partial-messages` parsed into SSE, zero token cost |
| Retry | gate retry counter, send-back opens a fresh session on purpose |
| Fan-out | per-group concurrency slots and the lease queue |
| Visual run graph | the pipeline view: one track per requirement, gates as ticks |

## n8n specifically

Different product. It integrates SaaS APIs behind a visual editor. The hard parts
here are a container per group, a lease queue for contended resources, git
checkouts and a serial merge queue. None of that is an n8n node.

## When this decision should be revisited

- Work becomes a fixed pipeline over many items with no human in the loop and no
  sandbox (a nightly batch). Then a DAG engine is the right tool and this is the
  wrong one.
- Agents need to run on several machines. Then a real queue broker matters, but
  that is a queue, still not a graph.

## Practical note

~8k lines and 328 checks already encode this. Swapping the substrate now is a
rewrite that buys no capability.
