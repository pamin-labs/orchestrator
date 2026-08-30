import { PanelRight, SlidersHorizontal } from "lucide-react";
import { type Dispatch, type ReactNode, type SetStateAction, useCallback, useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Toaster } from "sonner";
import { countWaiting, STATUS_LABEL } from "../shared/select";
import { useOrch } from "../shared/api";
import { cn } from "../ui/cn";
import { Pane } from "../ui/bits";
import { Boundary } from "./boundary";
import { HostAlert } from "./alerts";
import { Button } from "../ui/button";
import { Card, CardBody, CardTitle } from "../ui/card";
import { AskHost } from "../ui/confirm";
import { Switcher } from "../features/navigation/switcher";
import { Tip, TipRoot } from "../ui/tooltip";
import { UsageBar } from "../features/usage/view";
import { Home } from "../features/home/view";
import { NewRequirement } from "../features/requirement/newreq";
import { Notes } from "../features/notes/view";
import { FirstProject, Picker } from "../features/picker/view";
import { Progress } from "../features/progress/view";
import { Queue } from "../features/queue/view";
import { Requirement } from "../features/requirement/view";
import { SettingsDialog } from "../features/settings/view";
import { CostView, Desk, Owns } from "../features/tables/view";
import { Telemetry } from "../features/telemetry/view";
import { Timeline } from "../features/timeline/view";
import {
  backgroundView,
  bodyClass,
  choose,
  connectionText,
  contentKey,
  contentSlot,
  findById,
  idOrZero,
  itemName,
  isHome,
  navigationShortcut,
  orEmpty,
  nextSelection,
  parseSelection,
  projectForGroup,
  projectItem,
  projectNameProps,
  readSide,
  repairMissingGroup,
  requirementItem,
  resolveNavigation,
  scrollClass,
  selectionHash,
  settingsClass,
  settingsInitial,
  showNewRequirement,
  showRequirementCrumb,
  showSide,
  sideClass,
  sideText,
  type Selection,
  type Shortcut,
  VIEWS,
  viewActive,
  viewClass,
  waitingProject,
} from "../features/navigation/model";
import { Trans, useLingui } from "@lingui/react/macro";

type UiKey = "adding" | "pickProject" | "pickReq" | "picking" | "side";

function useUi() {
  const [ui, setUi] = useState(() => ({
    adding: false,
    pickProject: false,
    pickReq: false,
    picking: false,
    side: readSide(localStorage),
  }));
  const setter =
    (key: UiKey): Dispatch<SetStateAction<boolean>> =>
    (next) =>
      setUi((current) => ({ ...current, [key]: typeof next === "function" ? next(current[key]) : next }));
  return {
    ui,
    setAdding: setter("adding"),
    setPickProject: setter("pickProject"),
    setPickReq: setter("pickReq"),
    setPicking: setter("picking"),
    setSide: setter("side"),
  };
}

function Crumb({
  children,
  dim,
  onClick,
  className,
}: {
  children: ReactNode;
  dim?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer truncate font-display text-lead font-semibold transition-colors hover:text-ink",
        choose(!!dim, "text-ink-2", "text-ink"),
        className,
      )}
    >
      {children}
    </button>
  );
}

export function App() {
  const { t } = useLingui();
  const { state: st, cost, frames, live, refresh } = useOrch();
  const [sel, setSel] = useState<Selection>(() => parseSelection(location.hash));
  const { ui, setAdding, setPickProject, setPickReq, setPicking, setSide } = useUi();
  const [behind, setBehind] = useState<Selection["view"]>("progress");
  /**
   * `useCallback`, so it can be a dependency without being a reason to re-run.
   *
   * As a fresh function every render it was omitted from two dependency arrays —
   * `exhaustive-effect-dependencies` names both — and one of those arrays belongs
   * to the `keydown` listener, which was therefore added and removed on every
   * render of the whole app. `setSel` is stable and the updater closes over
   * nothing, so an empty list is the true one.
   */
  const go = useCallback((patch: Partial<Selection>) => setSel((current) => nextSelection(current, patch)), []);
  // A broken host check interrupts here, once per fault, rather than in a
  // terminal log nobody has open. Reads the snapshot that is already polled, and
  // hands the boss the pane that lists every check with its own controls.
  // `s` and not a `view`: the section is already part of a `Selection`, so this
  // lands on the pane that lists every check rather than on the dialog's first
  // tab with the boss one click from what they were told about.

  useEffect(() => {
    try {
      localStorage.setItem("orch.side", ui.side ? "1" : "0");
    } catch {}
  }, [ui.side]);
  /**
   * Both of these adjust state from state, which React documents doing during
   * render rather than in an effect: an effect renders once with the stale value
   * and then again with the new one, and `set-state-in-effect` is the rule that
   * says so. The guards are what stop them setting on every render — `behind` is
   * a string, and `repairMissingGroup` returns null when nothing is missing.
   */
  const background = backgroundView({ view: sel.view, g: sel.g });
  if (background && background !== behind) setBehind(background);
  useEffect(() => {
    const next = selectionHash(sel);
    if (next === location.hash) return;
    if (!location.hash) history.replaceState(null, "", next);
    else history.pushState(null, "", next);
  }, [sel]);
  useEffect(() => {
    if (sel.p) refresh(sel.p);
  }, [refresh, sel.p]);
  useEffect(() => {
    const handlers: Record<Shortcut, () => void> = {
      "toggle-side": () => setSide((value) => !value),
      settings: () => go({ view: "settings" }),
      "project-picker": () => setPickProject((value) => !value),
      "requirement-picker": () => setPickReq((value) => !value),
    };
    const onKey = (event: KeyboardEvent) => {
      const action = navigationShortcut(event, { view: sel.view, g: sel.g });
      if (!action) return;
      event.preventDefault();
      handlers[action]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, sel.view, sel.g, setSide, setPickProject, setPickReq]);
  const repair = repairMissingGroup(
    sel.g,
    st.groups.map((group) => group.id),
  );
  if (repair) go(repair);
  useEffect(() => {
    const onNavigation = () => setSel(parseSelection(location.hash));
    window.addEventListener("popstate", onNavigation);
    window.addEventListener("hashchange", onNavigation);
    return () => {
      window.removeEventListener("popstate", onNavigation);
      window.removeEventListener("hashchange", onNavigation);
    };
  }, []);

  const { section, view } = resolveNavigation(sel, behind);
  const project = findById(sel.p, st.projects);
  const home = isHome(view, !!project);
  const groups = st.groups.filter((group) => group.project_id === sel.p);
  const delivered = orEmpty(st.archived).some((archived) => archived.project_id === sel.p);
  const waiting = countWaiting(st, waitingProject(home, sel.p));
  const timeline = showSide(ui.side, home, st.projects.length);
  const openGroup = findById(sel.g, st.groups);
  const slot = contentSlot(st.projects.length, home, view, groups.length, delivered, !!openGroup);

  useEffect(() => {
    document.title = choose(waiting > 0, `(${waiting}) orchestrator`, "orchestrator");
  }, [waiting]);

  const openRequirement = (id: number) => {
    const group = findById(id, st.groups);
    go({ p: projectForGroup(group, sel.p), view: "req", g: id, t: null });
  };
  const added = (id: number) => {
    refresh();
    go({ p: id, view: "progress", g: null, t: null });
  };
  const content: Record<typeof slot, () => ReactNode> = {
    first: () => <FirstProject onAdded={added} onSettings={() => go({ view: "github" })} />,
    home: () => (
      <Home
        st={st}
        onEnter={(id) => go({ p: id, view: "progress", g: null })}
        onOpen={openRequirement}
        onNew={(id) => {
          go({ p: id });
          setAdding(true);
        }}
        onAdd={() => setPicking(true)}
        refresh={refresh}
      />
    ),
    progress: () => (
      <Progress
        st={st}
        projectId={idOrZero(sel.p)}
        onOpen={openRequirement}
        maxGroups={st.limits?.maxGroups}
        tab={sel.t}
        onTab={(tab) => go({ t: tab })}
        queue={<Queue st={st} projectId={sel.p} onOpen={openRequirement} refresh={refresh} />}
      />
    ),
    empty: () => (
      <Card className="max-w-[40rem]">
        <CardBody>
          <CardTitle>
            <Trans>No tickets yet</Trans>
          </CardTitle>
          <div className="mt-1 text-secondary text-ink-3">
            <Trans>Write a description, break into plan cards, then come back for review.</Trans>
          </div>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-rule-soft pt-3 text-secondary">
            <dt className="text-ink-3">
              <Trans>Repository</Trans>
            </dt>
            <dd className="truncate font-mono text-meta">{project?.repo_path}</dd>
            <dt className="text-ink-3">
              <Trans>Start from this branch</Trans>
            </dt>
            <dd className="font-mono text-meta">{project?.base_branch || t`Ask GitHub`}</dd>
            <dt className="text-ink-3">
              <Trans>Gates / Install commands</Trans>
            </dt>
            <dd className="text-ink-2">
              <Trans>Can't determine until first group clones; fill in settings later</Trans>
            </dd>
          </dl>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="go" onClick={() => setAdding(true)}>
              <Trans>+ New ticket</Trans>
            </Button>
            <Button variant="quiet" onClick={() => go({ view: "sandbox" })}>
              <Trans>Change base branch</Trans>
            </Button>
          </div>
        </CardBody>
      </Card>
    ),
    req: () => {
      if (!openGroup) return null;
      return (
        <Requirement
          st={st}
          g={openGroup}
          frames={frames}
          refresh={refresh}
          open
          tab={sel.t}
          onTab={(tab) => go({ t: tab })}
        />
      );
    },
    missing: () => (
      <div className="text-body text-ink-3">
        <Trans>This ticket has been archived or no longer exists.</Trans>
      </div>
    ),
    desk: () => <Desk st={st} frames={frames} projectId={idOrZero(sel.p)} />,
    notes: () => <Notes projectId={idOrZero(sel.p)} tab={sel.t} onTab={(tab) => go({ t: tab })} />,
    owns: () => <Owns st={st} projectId={idOrZero(sel.p)} />,
    // No `windowMs`. It asked for a week, on a comment claiming retention kept
    // seven days — retention is one, and the endpoint caps the parameter at
    // exactly that, so every project read came back
    // `Too big: expected number to be <=86400000` and the page said this project had
    // never run anything, over a table full of rows. Letting the endpoint choose its
    // own default is also the only version that stays correct when retention
    // moves, which is the reason the number should not have been here at all.
    time: () => (
      <Pane>
        <Telemetry
          scope={{ kind: "project", id: idOrZero(sel.p) }}
          trend
          empty={t`This project hasn't run any activity yet.`}
        />
      </Pane>
    ),
    cost: () => <CostView cost={cost} />,
  };

  return (
    <TipRoot>
      <Toaster position="bottom-right" theme="system" />
      <AskHost />
      <Picker open={ui.picking} onOpenChange={setPicking} onAdded={added} onSettings={() => go({ view: "github" })} />
      <Switcher
        open={ui.pickProject}
        onOpenChange={setPickProject}
        label={t`Switch project`}
        placeholder={t`Project name…`}
        empty={t`No matching projects`}
        items={st.projects.map((item) => projectItem(item, countWaiting(st, item.id)))}
        onPick={(id) => go({ p: id, g: null, view: "board" })}
      />
      <Switcher
        open={ui.pickReq}
        onOpenChange={setPickReq}
        label={t`Switch ticket`}
        placeholder={t`Ticket name…`}
        empty={t`No other tickets for this project`}
        items={groups.map((group) => requirementItem(group, t(STATUS_LABEL[group.status])))}
        onPick={(id) => go({ view: "req", g: id })}
      />
      {choose(
        !!sel.p,
        <NewRequirement open={ui.adding} onOpenChange={setAdding} projectId={idOrZero(sel.p)} onDone={refresh} />,
        null,
      )}
      <SettingsDialog
        open={!!section}
        onOpenChange={(open) => {
          if (!open) go({ view: behind, s: null });
        }}
        initial={settingsInitial(sel.s, section)}
        onSection={(next) => go({ s: next })}
        projectId={sel.p}
        {...projectNameProps(project)}
        groupCount={groups.length}
        onRemoved={() => {
          go({ p: null, g: null, view: "board" });
          refresh(null);
        }}
      />
      {/* Three rows, not two: the host banner is a row of the shell rather than
          an overlay, so a broken check never covers the board it is reporting
          about, and `minmax(0,1fr)` keeps the body scrolling on its own. */}
      <div className="grid h-dvh grid-rows-[auto_auto_minmax(0,1fr)]">
        <header className="z-10 flex h-14 items-center gap-5 border-b border-rule bg-rail px-6">
          <button
            type="button"
            className="cursor-pointer font-display text-card font-semibold"
            onClick={() => go({ view: "home", p: null, g: null })}
          >
            orchestrator
          </button>
          {choose(
            !home,
            <span className="flex min-w-0 shrink items-baseline gap-2 text-body">
              <span className="text-ink-3">/</span>
              <Crumb dim={view === "req"} onClick={() => setPickProject(true)}>
                {itemName(project)}
              </Crumb>
              {choose(
                showRequirementCrumb(view, !!openGroup),
                <>
                  <span className="text-ink-3">/</span>
                  <Crumb className="max-w-[18rem]" onClick={() => setPickReq(true)}>
                    {itemName(openGroup)}
                  </Crumb>
                </>,
                null,
              )}
              <span className="shrink-0 font-mono text-meta text-ink-3">⌘K</span>
            </span>,
            null,
          )}
          {choose(
            !home,
            <span className="flex min-w-0 gap-4 overflow-x-auto border-l border-rule pl-5">
              {VIEWS.map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => go({ view: key, g: null, t: null })}
                  className={cn(
                    "-mb-px cursor-pointer whitespace-nowrap border-b-2 py-1 text-body transition-colors",
                    viewClass(viewActive(view, key)),
                  )}
                >
                  {t(label)}
                </button>
              ))}
            </span>,
            null,
          )}
          <span className="grow" />
          <UsageBar usage={st.usage} />
          {choose(
            live !== "live",
            <span className="flex items-center gap-1.5 rounded-md bg-sunk px-2 py-0.5 font-mono text-meta text-warn">
              <i className="breathe size-1.5 rounded-full bg-warn" />
              {connectionText(live)}
            </span>,
            null,
          )}
          {choose(
            waiting > 0,
            <Button
              variant="go"
              size="sm"
              onClick={() => go(choose(!!sel.p, { view: "board", g: null }, { view: "home", p: null, g: null }))}
            >
              <Trans>to do {waiting}</Trans>
            </Button>,
            <span className="font-mono text-meta text-ink-3">
              <Trans>No pending items</Trans>
            </span>,
          )}
          {choose(
            showNewRequirement(sel.p, st.projects.length),
            <Button size="sm" className="ml-1" onClick={() => setAdding(true)}>
              <Trans>+ New ticket</Trans>
            </Button>,
            null,
          )}
          <span className="ml-2 flex items-center gap-1 border-l border-rule pl-3">
            {choose(
              !home,
              <Tip label={`${sideText(ui.side)} ⌘B`}>
                <button
                  type="button"
                  onClick={() => setSide((value) => !value)}
                  aria-label={t`Event stream`}
                  className={cn(
                    "grid size-6.5 cursor-pointer place-items-center rounded-md transition-colors hover:bg-sunk",
                    sideClass(ui.side),
                  )}
                >
                  <PanelRight size={14} strokeWidth={1.75} />
                </button>
              </Tip>,
              null,
            )}
            <Tip label={t`Settings: account, environment, skills, theme, and this project's gates and sandbox ⌘S`}>
              <button
                type="button"
                onClick={() => go({ view: "github" })}
                aria-label={t`Settings`}
                className={cn(
                  "relative grid size-6.5 cursor-pointer place-items-center rounded-md transition-colors hover:bg-sunk",
                  settingsClass(!!section),
                )}
              >
                <SlidersHorizontal size={14} strokeWidth={1.75} />
                {choose(
                  !st.ready,
                  <i className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent" aria-hidden />,
                  null,
                )}
              </button>
            </Tip>
          </span>
        </header>
        <HostAlert failing={st.failing} onFix={() => go({ view: "settings", s: "server" })} />
        <Group orientation="horizontal" className={cn("h-full min-h-0", bodyClass(timeline))}>
          <Panel className="min-w-0 overflow-hidden" defaultSize="100%">
            <div className={cn("flex h-full max-w-[76rem] flex-col px-6 pt-5", scrollClass(view))}>
              <Boundary key={contentKey(view, sel.p, sel.g)}>{content[slot]()}</Boundary>
            </div>
          </Panel>
          {choose(
            timeline,
            <>
              <Separator className="w-px shrink-0 cursor-col-resize bg-rule transition-colors hover:bg-accent data-[state=dragging]:bg-accent max-[64rem]:hidden" />
              <Panel defaultSize="20rem" minSize="14rem" maxSize="40rem" className="min-w-0">
                {/* The scroller moved inside `Timeline`: a windowed list has to own
                    the element it measures, and an ancestor two levels up with a
                    padding wrapper between is not that element. */}
                <aside className="h-full px-4 pt-4">
                  <Timeline st={st} frames={frames} grpId={sel.g} projectId={sel.p} />
                </aside>
              </Panel>
            </>,
            null,
          )}
        </Group>
      </div>
    </TipRoot>
  );
}
