import { Meta, Pane } from "../../ui/bits";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Tab, TabList, TabPanel, Tabs } from "../../ui/tabs";
import { Tip } from "../../ui/tooltip";
import { prUrl } from "../../shared/select";
import { cardGoal } from "../../shared/prose";
import type { Archived, Group, Slice, State } from "../../shared/api";
import { usePaged } from "../../shared/page";
import { STOPS, countWaiting, gates, heldApproved, statusLabel } from "../../shared/select";
import { K } from "../../shared/format";
import { cn } from "../../ui/cn";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/** Requirements are state-filtered, paged, and counted on their tabs. */

interface Bucket {
  key: string;
  label: MessageDescriptor;
  of: string[];
  mine?: boolean;
}

/** `To do` renders the boss queue; `In progress` owns every undelivered requirement. */
const BUCKETS: Bucket[] = [
  { key: "mine", label: msg`To do`, of: [], mine: true },
  { key: "live", label: msg`In progress`, of: ["RUNNING", "PLANNING", "PAUSING", "DRAFT", "PR_OPEN"] },
  { key: "held", label: msg`Stopped`, of: ["PAUSED", "PARKED"] },
];
const DONE = "done";

/**
 * A placeholder takes the name of the expression that fills it, so
 * `value={facts.waiting}` reaches a translator as `{0}` and a parameter reaches
 * them as itself — which is the whole of the context they get for a plural.
 */
const AwaitingBadge = ({ waiting }: { waiting: number }) => (
  <Badge tone="mine">
    <Plural value={waiting} one="# slice awaiting acceptance" other="# slices awaiting acceptance" />
  </Badge>
);

const SliceCount = ({ n }: { n: number }) => <Plural value={n} one="# slice" other="# slices" />;

/** `Accepted 3/7`, in one message rather than three fragments. */
const acceptedOf = (done: number, total: number): string => t`accepted ${done}/${total}`;

export function Progress({
  st,
  projectId,
  onOpen,
  maxGroups,
  tab,
  onTab,
  queue,
}: {
  st: State;
  projectId: number;
  onOpen: (id: number) => void;
  maxGroups?: number | null;
  /** From the hash, so it survives opening a requirement and coming back. */
  tab: string | null;
  onTab: (t: string) => void;
  /** What needs the boss. Rendered as the `To do` tab, not above it. */
  queue?: React.ReactNode;
}) {
  const { t } = useLingui();
  const groups = st.groups.filter((g) => g.project_id === projectId);
  const archived = (st.archived ?? []).filter((a) => a.project_id === projectId);
  // A group already approved is not the boss's to act on: it belongs with the
  // other things that are simply waiting.
  const of = (b: Bucket) => groups.filter((g) => (heldApproved(g) ? b.key === "held" : b.of.includes(g.status)));
  const live = groups.filter((g) => ["RUNNING", "PLANNING", "PAUSING"].includes(g.status)).length;
  const todo = countWaiting(st, projectId);

  // Open on the tab that has something for the boss; failing that, on the work.
  // Only when the boss has not chosen one — this used to be component state, so
  // drilling into a requirement unmounted the list and this heuristic quietly
  // overrode their choice on the way back.
  const fallback = todo
    ? "mine"
    : (BUCKETS.slice(1).find((b) => of(b).length)?.key ?? (archived.length ? DONE : "live"));

  // No early return for "this project has no requirements". It said, in its own
  // words, what `emptyOf("live")` already says inside the `In progress` bucket.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs value={tab ?? fallback} onValueChange={onTab} className="flex min-h-0 flex-1 flex-col">
        <TabList>
          {BUCKETS.map((b) => (
            <Tab
              key={b.key}
              value={b.key}
              count={b.mine ? todo : of(b).length}
              {...(b.mine !== undefined ? { mine: b.mine } : {})}
            >
              {t(b.label)}
            </Tab>
          ))}
          <Tab value={DONE} count={archived.length}>
            <Trans>Done</Trans>
          </Tab>
          <span className="grow" />
          {/* The slot cap is why an approved requirement can sit still: queued, not
            stuck. Without it that difference is invisible. */}
          {maxGroups != null && (
            <Tip
              label={t`At most ${maxGroups} groups at once. When it is full, approved requirements queue for a slot rather than being stuck.`}
            >
              <Meta className={cn("self-center underline decoration-dotted", live >= maxGroups && "text-warn")}>
                <Trans>
                  running {live}/{maxGroups}
                </Trans>
              </Meta>
            </Tip>
          )}
        </TabList>

        {BUCKETS.map((b) => (
          <TabPanel key={b.key} value={b.key} className="flex min-h-0 flex-1 flex-col">
            <Pane>{b.mine ? queue : <List st={st} groups={of(b)} onOpen={onOpen} empty={emptyOf(b.key)} />}</Pane>
          </TabPanel>
        ))}
        <TabPanel value={DONE} className="flex min-h-0 flex-1 flex-col">
          <Pane>
            <Done rows={archived} />
          </Pane>
        </TabPanel>
      </Tabs>
    </div>
  );
}

/** Absence, with the reason it is absent. A bare "none" teaches nothing. */
function emptyOf(key: string): string {
  // No `mine` case: that bucket renders the queue, which carries its own empty
  // line. The copy that lived here was a second, drifting version of it.
  if (key === "live") return t`No requirements in progress. Click + for a new one in the top right.`;
  return t`No paused requirements. Groups pause here when budget is exhausted or waiting for your answer exceeds 2 hours; work is kept.`;
}

function List({
  st,
  groups,
  onOpen,
  empty,
}: {
  st: State;
  groups: Group[];
  onOpen: (id: number) => void;
  empty: string;
}) {
  const { page, rest, more, total } = usePaged(groups, 25);
  if (!groups.length) return <div className="text-body text-ink-3">{empty}</div>;
  return (
    <>
      {page.map((g) => (
        <Row key={g.id} st={st} g={g} onOpen={onOpen} />
      ))}
      {rest > 0 && (
        <Button variant="quiet" size="sm" className="mt-2" onClick={more}>
          <Trans>
            {rest} more of {total}
          </Trans>
        </Button>
      )}
    </>
  );
}

interface RowFacts {
  slices: Slice[];
  doing: State["agents"][number] | undefined;
  waiting: number;
  done: number;
  card: State["draftCards"][number] | undefined;
  broke: boolean;
}

function rowFacts(st: State, group: Group): RowFacts {
  const slices = st.slices.filter((slice) => slice.grp_id === group.id);
  return {
    slices,
    doing: st.agents.find((agent) => agent.grp_id === group.id && agent.state === "running"),
    waiting: slices.filter((slice) => slice.status === "awaiting_boss").length,
    done: slices.filter((slice) => slice.status === "accepted").length,
    card: st.draftCards.find((card) => card.grpId === group.id),
    broke: group.budget_tokens != null && group.spent_tokens >= group.budget_tokens,
  };
}

function rowBody(group: Group, facts: RowFacts): React.ReactNode {
  if (group.status === "PLANNING")
    return (
      <span className="text-secondary text-ink-3">
        <Trans>Dispatcher is analyzing; no slices yet</Trans>
      </span>
    );
  if (heldApproved(group))
    return (
      <span className="text-secondary text-ink-3">
        <Trans>Approved; starts automatically when boundaries clear</Trans>
      </span>
    );
  if (group.status === "DRAFT") {
    const goal = facts.card
      ? cardGoal(facts.card.body) || t`Plan card pending approval`
      : t`Plan card not submitted yet`;
    return <span className="block truncate text-secondary text-ink-2">{goal}</span>;
  }
  if (!facts.slices.length)
    return (
      <span className="text-secondary text-ink-3">
        <Trans>No slices</Trans>
      </span>
    );
  return (
    <div className="flex flex-wrap items-stretch gap-1.5">
      {facts.slices.map((slice) => (
        <Seg key={slice.id} s={slice} />
      ))}
    </div>
  );
}

function RunningActivity({ agent }: { agent: RowFacts["doing"] }) {
  if (!agent) return null;
  return (
    <div className="mt-1 truncate font-mono text-meta text-ink-2">
      {agent.role} ▸ {agent.activity}
    </div>
  );
}

function RowFlags({ st, group, facts }: { st: State; group: Group; facts: RowFacts }) {
  const url = group.status === "PR_OPEN" ? prUrl(st, group) : null;
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      {facts.broke && (
        <Badge tone="mine">
          <Trans>Budget exhausted</Trans>
        </Badge>
      )}
      {facts.waiting > 0 && <AwaitingBadge waiting={facts.waiting} />}
      {group.status === "PR_OPEN" &&
        (url ? (
          <Badge
            tone="mine"
            className="cursor-pointer underline decoration-dotted underline-offset-2"
            onClick={(event) => {
              event.stopPropagation();
              // fallow-ignore-next-line security-sink -- `url` is `prUrl`, which returns either null or a literal `https://github.com/` prefix followed by two `[\w.-]+` segments it matched out of the remote; the stored remote cannot contribute a scheme or a host.
              window.open(url, "_blank", "noopener");
            }}
          >
            <Trans>Go merge PR ↗</Trans>
          </Badge>
        ) : (
          <Badge tone="mine">
            <Trans>PR pending merge</Trans>
          </Badge>
        ))}
      <Meta>{group.branch ?? ""}</Meta>
    </span>
  );
}

function Row({ st, g, onOpen }: { st: State; g: Group; onOpen: (id: number) => void }) {
  const facts = rowFacts(st, g);
  return (
    <button
      type="button"
      onClick={() => onOpen(g.id)}
      className={cn(
        "grid w-full cursor-pointer grid-cols-[14rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5",
        // `rail`, not `sunk`: an accepted slice's card is `bg-sunk`, so a row that
        // hovers to that colour makes the cards it is made of disappear.
        "border-t border-rule-soft first:border-t-0 px-2 py-2.5 text-left transition-colors hover:bg-rail/70",
        "max-[60rem]:grid-cols-[minmax(0,1fr)_auto]",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-display text-name font-semibold">{g.name}</span>
          {facts.doing && <i className="breathe size-1.5 shrink-0 rounded-full bg-ok" />}
        </div>
        <Meta>
          {statusLabel(g)}
          {facts.slices.length ? ` · ${acceptedOf(facts.done, facts.slices.length)}` : ""}
          {g.spent_tokens ? ` · ${K(g.spent_tokens)} tokens` : ""}
        </Meta>
      </div>
      <div className="min-w-0 max-[60rem]:col-span-full">
        {rowBody(g, facts)}
        <RunningActivity agent={facts.doing} />
      </div>
      <RowFlags st={st} group={g} facts={facts} />
    </button>
  );
}

function sliceMark(slice: Slice): string {
  if (slice.status === "awaiting_boss") return t`Pending`;
  const marks: Partial<Record<Slice["status"], string>> = { accepted: "✓", rejected: t`Rejected`, pending: t`Waiting` };
  return marks[slice.status] ?? "";
}

function sliceBorder(slice: Slice, failed: boolean): string {
  if (slice.status === "awaiting_boss") return "border-accent bg-accent-soft";
  if (slice.status === "accepted") return "border-rule-soft bg-sunk";
  if (failed || slice.status === "rejected") return "border-bad";
  if (slice.status === "pending") return "border-rule";
  return "border-ink-3";
}

function gateClass(status: string | undefined, active: boolean): string | false {
  if (status === "pass") return "bg-ok";
  if (status === "fail") return "bg-bad";
  return active && "breathe bg-ink-3";
}

/** One slice: its place in the order, and which gates it has passed. */
function Seg({ s }: { s: Slice }) {
  const gs = gates(s);
  const waiting = s.status === "awaiting_boss";
  const failed = Object.values(gs).includes("fail");
  return (
    <Tip label={`${s.title} — ${s.accept_spec}`}>
      <span className={cn("w-32 shrink-0 rounded-[0.3125rem] border px-1.5 py-1", sliceBorder(s, failed))}>
        <span
          className={cn(
            "flex items-center gap-1 font-mono text-pill text-ink-3",
            waiting && "font-semibold text-accent",
          )}
        >
          S{s.seq}
          <span className="grow" />
          {sliceMark(s)}
        </span>
        <span className="mt-px block truncate text-meta text-ink-2">{s.title}</span>
        {/* The layers review.ts actually records. `self` was drawn here for a while
            and recorded nowhere, so the first tick sat grey forever — and the layer
            it stood in for, reconcile, is the one docs/project/plan.md §7 calls worth more than
            the whole Auditor. Progress is which gates passed, never a percentage:
            a model's percentage is a guess, a gate is a fact. */}
        <span className="mt-1 flex gap-1">
          {STOPS.map(([k]) => (
            <i key={k} className={cn("tick", gateClass(gs[k], s.status === k))} />
          ))}
        </span>
      </span>
    </Tip>
  );
}

/** Delivered work. Winding up dissolves the group, and it used to leave no trace at all. */
function Done({ rows }: { rows: Archived[] }) {
  const { page, rest, more, total } = usePaged(rows, 25);
  if (!rows.length) {
    return (
      <div className="text-body text-ink-3">
        <Trans>No deliveries yet. Requirements are archived here after merging to main.</Trans>
      </div>
    );
  }
  return (
    <>
      {page.map((a) => (
        <div
          key={a.id}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-t border-rule-soft first:border-t-0 px-2 py-2"
        >
          <span className="min-w-0 truncate text-body text-ink-2">
            {a.name}
            {a.pr_number ? <Meta className="ml-2">#{a.pr_number}</Meta> : null}
          </span>
          <Meta>
            <SliceCount n={a.slices} />
          </Meta>
        </div>
      ))}
      {rest > 0 && (
        <Button variant="quiet" size="sm" className="mt-2" onClick={more}>
          <Trans>
            {rest} more of {total}
          </Trans>
        </Button>
      )}
    </>
  );
}
