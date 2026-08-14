import { PanelRight, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { Button } from "./ui/button";
import { AskHost } from "./ui/confirm";
import { Switcher } from "./ui/switcher";
import { STATUS_ZH } from "./lib/select";
import { ThemeToggle } from "./ui/theme";
import { UsageBar } from "./ui/usage";
import { Tip, TipRoot } from "./ui/tooltip";
import { Card, CardBody, CardTitle } from "./ui/card";
import { Boundary } from "./ui/boundary";
import { useOrch } from "./lib/api";
import { countWaiting } from "./lib/select";
import { Group, Panel, Separator } from "react-resizable-panels";
import { cn } from "./lib/utils";
import { Home } from "./views/home";
import { NewRequirement } from "./views/newreq";
import { Picker } from "./views/picker";
import { Notes } from "./views/notes";
import { SettingsDialog, type Section } from "./views/settings";
import { Progress } from "./views/progress";
import { Queue } from "./views/queue";
import { Requirement } from "./views/requirement";
import { Timeline } from "./views/timeline";
import { CostView, Desk, Owns } from "./views/tables";

// `req` is a drill-in, not a tab: it only exists with a requirement selected, and
// the breadcrumb is the way back out. `progress` deep links from before (and from
// every notification already sent) carry a group id, so they land on the drill-in.
type View = "home" | "board" | "progress" | "req" | "desk" | "owns" | "cost" | "notes" | "settings" | "config";

/**
 * Views that keep something pinned and scroll the rest themselves.
 *
 * They own a tab strip, a verdict line or a rail that has to stay put while a
 * long list moves past it. Everything else scrolls whole, which is right when the
 * page has no controls of its own to lose.
 */
const SELF_SCROLL = new Set<View>(["cost", "owns", "desk", "notes", "progress", "req"]);

/**
 * The two hashes that open the settings dialog rather than a view.
 *
 * `config` was a peer tab and `settings` was the gear, and they were two pages
 * built from the same three components that never said which scope they were.
 * They are one dialog now, two groups in its left rail — but every link already
 * sent still lands, on the section it used to be.
 */
const DIALOG: Partial<Record<View, Section>> = { settings: "cred", config: "gates" };
interface Sel { p: number | null; view: View; g: number | null; t: string | null }

const readHash = (): Sel => {
  const h = new URLSearchParams(location.hash.slice(1));
  return {
    p: h.get("p") ? Number(h.get("p")) : null,
    view: (h.get("v") as View) || "home",
    g: h.get("g") ? Number(h.get("g")) : null,
    // Which tab, inside whichever view has them. In the hash for the same reason
    // the other three are: a tab lived in component state, so opening a
    // requirement unmounted the list and coming back re-picked a tab by heuristic
    // — the boss's choice silently replaced by ours, at the one moment they were
    // navigating back to it.
    t: h.get("t"),
  };
};

/** A name in the trail. Clicking it offers the others of its kind. */
function Crumb({
  children, dim, onClick, className,
}: {
  children: React.ReactNode; dim?: boolean; onClick: () => void; className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "cursor-pointer truncate font-display text-[1rem] font-semibold transition-colors hover:text-ink",
        dim ? "text-ink-2" : "text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function App() {
  const { state: st, cost, frames, live, refresh } = useOrch();
  const [sel, setSel] = useState<Sel>(readHash);
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pickProject, setPickProject] = useState(false);
  const [pickReq, setPickReq] = useState(false);
  const [side, setSide] = useState(() => {
    // Hiding the feed has to survive a reload, or it is not a setting, it is a twitch.
    try {
      return localStorage.getItem("orch.side") !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("orch.side", side ? "1" : "0");
    } catch {}
  }, [side]);

  // What the settings dialog is floating over. Remembered rather than derived:
  // its own hash replaced the view, and closing has to put the boss back where
  // they were rather than on a default.
  const [behind, setBehind] = useState<View>("progress");
  useEffect(() => {
    const v: View = sel.view === "board" ? "progress" : sel.view;
    if (!DIALOG[v]) setBehind(v === "progress" && sel.g ? "req" : v);
  }, [sel.view, sel.g]);

  const go = (patch: Partial<Sel>) => setSel((s) => ({ ...s, ...patch }));

  // Push, don't replace: replacing meant Home → project → requirement left one
  // history entry, so Back walked out of the app instead of back up the hierarchy.
  // The guard keeps a Back-triggered state update from pushing the entry again.
  useEffect(() => {
    const h = new URLSearchParams();
    if (sel.p) h.set("p", String(sel.p));
    h.set("v", sel.view);
    if (sel.g) h.set("g", String(sel.g));
    if (sel.t) h.set("t", sel.t);
    const next = `#${h}`;
    if (next === location.hash) return;
    if (!location.hash) history.replaceState(null, "", next);
    else history.pushState(null, "", next);
  }, [sel]);
  // 成本 says "this project", so it must be fetched for this project. refresh()
  // takes the id; nothing was passing it.
  useEffect(() => {
    if (sel.p) void refresh(sel.p);
  }, [sel.p]);
  // ⌘K switches whatever the boss is standing in. Inside a requirement that is
  // the requirement — offering the project list there means the shortcut does the
  // wrong thing at exactly the depth it is most useful.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "k" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      if (sel.view === "req" && sel.g) setPickReq((v) => !v);
      else setPickProject((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel.view, sel.g]);

  // A requirement that left the board — dropped, merged — takes its id with it,
  // and the hash still points at it. Nothing could clear that: the 需求 tab kept
  // `g`, so it reopened the drill-in on a group that no longer exists and the list
  // was unreachable without editing the URL.
  useEffect(() => {
    if (!sel.g || !st.groups.length) return;
    if (!st.groups.some((g) => g.id === sel.g)) go({ g: null, view: "progress", t: null });
  }, [sel.g, st.groups]);

  useEffect(() => {
    const onNav = () => setSel(readHash());
    // popstate covers Back/Forward; hashchange covers a hand-edited fragment and
    // the deep links the notifications hand out.
    window.addEventListener("popstate", onNav);
    window.addEventListener("hashchange", onNav);
    return () => {
      window.removeEventListener("popstate", onNav);
      window.removeEventListener("hashchange", onNav);
    };
  }, []);

  // A notification sent before this split points at #v=progress&g=N.
  // 概览 was 待办 plus the same requirement list 需求 shows, so it is gone and its
  // queue sits on top of that list. Links already sent still work: the hash is
  // rewritten rather than 404'd.
  const asked: View = sel.view === "board" ? "progress" : sel.view;
  // The dialog floats over whatever the boss was standing on, so its hash is not a
  // view: the page underneath keeps rendering the last one that was.
  const section = DIALOG[asked];
  const view: View = section ? behind : asked === "progress" && sel.g ? "req" : asked;

  const proj = st.projects.find((p) => p.id === sel.p);
  const home = view === "home" || !proj;
  const groups = st.groups.filter((g) => g.project_id === sel.p);
  // Scoped to where the boss is standing: inside a project it is that project's
  // queue, on Home it is everything.
  const waiting = countWaiting(st, home ? null : sel.p);
  // Home spans projects, so a timeline there would be cross-project noise while
  // the boss is deciding. It only appears inside a project.
  const showSide = side && !home && st.projects.length > 0;

  const openReq = (grpId: number) => {
    const g = st.groups.find((x) => x.id === grpId);
    // Without clearing `t`, the tab the boss was standing on in the list (`live`)
    // followed them into the drill-in, which has no such tab and so opened on
    // nothing.
    go({ p: g?.project_id ?? sel.p, view: "req", g: grpId, t: null });
  };
  // No badge on 概览: the header already carries that count, and two copies of one
  // number is how a reader stops trusting either.
  // 「进展」 named a feeling, not a thing. The page is the list of requirements, and
  // `grp` is the requirement — so the tab is 需求, matching the vocabulary PLAN.md
  // uses everywhere else. The hash key stays `progress` so links already sent still
  // land.
  const VIEWS: [View, string][] = [
    ["progress", "需求"],
    ["desk", "工位墙"],
    ["notes", "记录"],
    ["owns", "所有权"],
    ["cost", "成本"],
  ];
  const openGroup = sel.g ? st.groups.find((g) => g.id === sel.g) : undefined;

  return (
    <TipRoot>
      <Toaster position="bottom-right" theme="system" />
      <AskHost />
      <Picker open={picking} onOpenChange={setPicking} onAdded={refresh} />
      <Switcher
        open={pickProject}
        onOpenChange={setPickProject}
        label="切换项目"
        placeholder="项目名…"
        empty="没有匹配的项目"
        items={st.projects.map((p) => ({
          id: p.id,
          name: p.name,
          meta: p.repo_path,
          rtlMeta: true,
          badge: countWaiting(st, p.id) > 0 ? `${countWaiting(st, p.id)} 件待办` : undefined,
        }))}
        onPick={(id) => go({ p: id, g: null, view: "board" })}
      />
      <Switcher
        open={pickReq}
        onOpenChange={setPickReq}
        label="切换需求"
        placeholder="需求名…"
        empty="这个项目没有别的需求"
        items={groups.map((g) => ({
          id: g.id,
          name: g.name,
          meta: `${STATUS_ZH[g.status] ?? g.status}${g.branch ? ` · ${g.branch}` : ""}`,
        }))}
        onPick={(id) => go({ view: "req", g: id })}
      />
      {sel.p && (
        <NewRequirement open={adding} onOpenChange={setAdding} projectId={sel.p} onDone={refresh} />
      )}
      {/* The hash names the way in, not the section the boss is standing on: once
          it is open the left rail moves inside it. */}
      <SettingsDialog
        open={!!section}
        onOpenChange={(o) => !o && go({ view: behind })}
        initial={section ?? "cred"}
        projectId={sel.p}
        projectName={proj?.name}
      />

      {/*
        The bar carries what the boss acts on, and nothing that is merely true.
        Total spend was there and belongs in 成本, where it can be attributed; a
        green "live" dot that is green all day teaches the eye to skip the corner
        it lives in, so connection state only appears when it is broken.

        Subscription usage is the one addition that passes that test. It is not
        spend — it is how much of tonight is left on each of the two accounts, and
        it changes what the boss approves next. It stays grey until 80%.
      */}
      {/* The shell is a fixed-height grid: header sized to itself, the rest taking
          exactly what is left. It used to be a sticky header plus a region measured
          as calc(100vh - 3.5rem) — the same height written twice, in two units, so
          any change to the header silently detuned the region below it, and a child
          that overflowed grew the window because nothing above it was constrained. */}
      <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)]">
      <header className="z-10 flex h-14 items-center gap-5 border-b border-rule bg-rail px-6">
        <button
          className="cursor-pointer font-display text-[1.0625rem] font-semibold"
          onClick={() => go({ view: "home", p: null, g: null })}
        >
          orchestrator
        </button>
        {/* Each name in the trail switches to another of its own kind. A separate
            切换 control beside them had to explain which of the two it meant, and
            the answer changed depending on how deep the boss had drilled in. */}
        {!home && (
          <span className="flex min-w-0 shrink items-baseline gap-2 text-[0.8125rem]">
            <span className="text-ink-3">/</span>
            <Crumb dim={view === "req"} onClick={() => setPickProject(true)}>
              {proj!.name}
            </Crumb>
            {view === "req" && openGroup && (
              <>
                <span className="text-ink-3">/</span>
                    {/* Requirement names are a sentence the boss typed, and one of
                    them ran the views off the bar. The trail gives up width
                    first: it says where you are, and the tabs are how you leave. */}
                <Crumb className="max-w-[18rem]" onClick={() => setPickReq(true)}>
                  {openGroup.name}
                </Crumb>
              </>
            )}
            <span className="shrink-0 font-mono text-[0.6875rem] text-ink-3">⌘K</span>
          </span>
        )}
        {/* The views, on the same line as everything else. They had a row of
            their own, which read as a second tab bar above whatever tabs the view
            itself has — three levels of the same affordance stacked. Five items
            fit here, and the row they cost is worth more to the list below. */}
        {/* A rule between the trail and the views: they were touching, and two
            different kinds of navigation reading as one run of words is how you
            click the wrong one. */}
        {!home && (
          <span className="flex min-w-0 gap-4 overflow-x-auto border-l border-rule pl-5">
            {VIEWS.map(([k, zh]) => (
              <button
                key={k}
                // Every tab clears the drill-in, 需求 included: keeping `g` there
                // made the tab reopen the requirement the boss was trying to leave.
                onClick={() => go({ view: k, g: null, t: null })}
                className={cn(
                  "-mb-px cursor-pointer whitespace-nowrap border-b-2 py-1 text-[0.8125rem] transition-colors",
                  // The drill-in belongs to 需求, so that tab stays lit inside it.
                  view === k || (view === "req" && k === "progress")
                    ? "border-accent font-medium text-ink"
                    : "border-transparent text-ink-3 hover:text-ink",
                )}
              >
                {zh}
              </button>
            ))}
          </span>
        )}
        <span className="grow" />
        {/* Three groups, three rhythms: what is true (usage, queue), what you can
            do (new requirement), and the two switches. They had one gap between
            every pair, which reads as a single run of eight things rather than
            three groups of two or three. */}
        <UsageBar usage={st.usage} />
        {live !== "live" && (
          <span className="flex items-center gap-1.5 rounded-md bg-sunk px-2 py-0.5 font-mono text-[0.6875rem] text-warn">
            <i className="breathe size-1.5 rounded-full bg-warn" />
            {live === "retry" ? "连接断了，重连中" : "连接中"}
          </span>
        )}
        {/* One number, always the same number: how many things cannot move without
            you. Zero is a state worth showing plainly — it is the goal. */}
        {waiting > 0 ? (
          <Button
            variant="go"
            size="sm"
            onClick={() => go(sel.p ? { view: "board", g: null } : { view: "home", p: null, g: null })}
          >
            待办 {waiting}
          </Button>
        ) : (
          <span className="font-mono text-[0.6875rem] text-ink-3">无待办</span>
        )}
        {sel.p && !!st.projects.length && (
          <Button size="sm" className="ml-1" onClick={() => setAdding(true)}>＋ 新需求</Button>
        )}
        <span className="ml-2 flex items-center gap-1 border-l border-rule pl-3">
        {!home && (
          <Tip label={side ? "收起事件流" : "展开事件流：谁跟谁说了什么，按时间倒序"}>
            <button
              onClick={() => setSide((v) => !v)}
              aria-label="事件流"
              className={cn(
                "grid size-6.5 cursor-pointer place-items-center rounded-md transition-colors hover:bg-sunk",
                side ? "text-ink" : "text-ink-3 hover:text-ink",
              )}
            >
              <PanelRight size={14} strokeWidth={1.75} />
            </button>
          </Tip>
        )}
        {/* Not a sixth peer view. The five answer "where is the work"; this
            answers "is this wired up", which is asked once and then never again
            until something breaks — and when it does break, the accent says so
            from here. It opens over the work rather than replacing it. */}
        <Tip label="设置：凭据、环境、这个项目的闸门和沙盒">
          <button
            onClick={() => go({ view: "settings" })}
            aria-label="设置"
            className={cn(
              "relative grid size-6.5 cursor-pointer place-items-center rounded-md transition-colors hover:bg-sunk",
              section ? "text-ink" : "text-ink-3 hover:text-ink",
            )}
          >
            <SlidersHorizontal size={14} strokeWidth={1.75} />
            {!st.ready && (
              <i className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent" aria-hidden />
            )}
          </button>
        </Tip>
        <ThemeToggle />
        </span>
      </header>


      {/* Draggable when the feed is open. 20rem was a guess that has to serve both
          "glance at what just happened" and "read a long journal entry", and the
          reader is the only one who knows which. Below 64rem it goes back to one
          column: there is no width to split. */}
      {/* The document does not scroll; the view does. Header and nav were sticky,
          which kept them visible but still let the page grow to whatever the
          longest list wanted — so every view had a different height and the
          scrollbar belonged to the window. One region, fixed to the viewport, and
          each view decides what scrolls inside it. 4.5rem is header plus nav. */}
      <Group
        orientation="horizontal"
        className={cn("h-full min-h-0", showSide ? "flex max-[64rem]:block" : "block")}
      >
        <Panel className="min-w-0 overflow-hidden" defaultSize="100%">
          {/* The view decides what scrolls. 成本 has a tab strip and a rail that
              must stay put, so it manages its own panes; everything else scrolls
              whole. Two scrollbars, or a page that grows past the viewport with
              its controls at the top, are the two failures this picks between. */}
          <div
            className={cn(
              "flex h-full max-w-[76rem] flex-col px-6 pt-5",
              SELF_SCROLL.has(view) ? "overflow-hidden pb-4" : "overflow-y-auto pb-16",
            )}
          >
          <Boundary key={`${sel.view}:${sel.p}:${sel.g}`}>
          {!st.projects.length ? (
            <Card className="max-w-[40rem]">
              <CardBody>
                <CardTitle>添加项目</CardTitle>
                <div className="mb-3 mt-1 text-[0.75rem] text-ink-3">
                  本地 git 仓库。注册时自动检测测试命令、写入职包、预检 PR 权限。
                </div>
                <Button variant="go" onClick={() => setPicking(true)}>挑文件夹…</Button>
              </CardBody>
            </Card>
          ) : home ? (
            <Home st={st} onEnter={(p) => go({ p, view: "progress", g: null })} onOpen={openReq}
                  onAdd={() => setPicking(true)} refresh={refresh} />
          ) : view === "progress" ? (
            groups.length ? (
              <Progress
                st={st}
                projectId={sel.p!}
                onOpen={openReq}
                maxGroups={st.limits?.maxGroups}
                tab={sel.t}
                onTab={(t) => go({ t })}
                queue={<Queue st={st} projectId={sel.p} onOpen={openReq} refresh={refresh} />}
              />
            ) : (
              <Card>
                <CardBody>
                  <CardTitle>还没有需求</CardTitle>
                  <div className="mt-1 text-[0.75rem] text-ink-3">
                    写一句话就行。拆成计划卡再回来给你批，20 秒。
                  </div>
                  <Button variant="go" className="mt-3" onClick={() => setAdding(true)}>＋ 新需求</Button>
                </CardBody>
              </Card>
            )
          ) : view === "req" ? (
            openGroup ? (
              <Requirement st={st} g={openGroup} refresh={refresh} open tab={sel.t} onTab={(t) => go({ t })} />
            ) : (
              <div className="text-[0.8125rem] text-ink-3">这个需求已经归档或不存在了。</div>
            )
          ) : view === "desk" ? (
            <Desk st={st} frames={frames} projectId={sel.p!} />
          ) : view === "notes" ? (
            <Notes projectId={sel.p!} tab={sel.t} onTab={(t) => go({ t })} />
          ) : view === "owns" ? (
            <Owns st={st} projectId={sel.p!} />
          ) : (
            <CostView cost={cost} />
          )}
          </Boundary>
          </div>
        </Panel>
        {showSide && (
          <>
            <Separator className="w-px shrink-0 cursor-col-resize bg-rule transition-colors hover:bg-accent data-[state=dragging]:bg-accent max-[64rem]:hidden" />
            <Panel defaultSize="20rem" minSize="14rem" maxSize="40rem" className="min-w-0">
              <aside className="h-full overflow-auto">
                <div className="px-4 pb-24 pt-4">
                  <Timeline st={st} frames={frames} grpId={sel.g} projectId={sel.p} />
                </div>
              </aside>
            </Panel>
          </>
        )}
      </Group>
      </div>
    </TipRoot>
  );

}
