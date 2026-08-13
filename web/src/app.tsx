import { PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { Button } from "./ui/button";
import { AskHost } from "./ui/confirm";
import { Switcher } from "./ui/switcher";
import { ThemeToggle } from "./ui/theme";
import { Tip, TipRoot } from "./ui/tooltip";
import { Card, CardBody, CardTitle } from "./ui/card";
import { Boundary } from "./ui/boundary";
import { useOrch } from "./lib/api";
import { countWaiting } from "./lib/select";
import { cn } from "./lib/utils";
import { Home } from "./views/home";
import { NewRequirement } from "./views/newreq";
import { Picker } from "./views/picker";
import { Pipeline } from "./views/pipeline";
import { Queue } from "./views/queue";
import { Requirement } from "./views/requirement";
import { Timeline } from "./views/timeline";
import { CostView, Delivered, Desk, Owns } from "./views/tables";

type View = "home" | "board" | "progress" | "desk" | "owns" | "cost";
interface Sel { p: number | null; view: View; g: number | null }

const readHash = (): Sel => {
  const h = new URLSearchParams(location.hash.slice(1));
  return {
    p: h.get("p") ? Number(h.get("p")) : null,
    view: (h.get("v") as View) || "home",
    g: h.get("g") ? Number(h.get("g")) : null,
  };
};

export function App() {
  const { state: st, cost, frames, live, refresh } = useOrch();
  const [sel, setSel] = useState<Sel>(readHash);
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [side, setSide] = useState(true);

  const go = (patch: Partial<Sel>) => setSel((s) => ({ ...s, ...patch }));

  // Push, don't replace: replacing meant Home → project → requirement left one
  // history entry, so Back walked out of the app instead of back up the hierarchy.
  // The guard keeps a Back-triggered state update from pushing the entry again.
  useEffect(() => {
    const h = new URLSearchParams();
    if (sel.p) h.set("p", String(sel.p));
    h.set("v", sel.view);
    if (sel.g) h.set("g", String(sel.g));
    const next = `#${h}`;
    if (next === location.hash) return;
    if (!location.hash) history.replaceState(null, "", next);
    else history.pushState(null, "", next);
  }, [sel]);
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

  const proj = st.projects.find((p) => p.id === sel.p);
  const home = sel.view === "home" || !proj;
  const groups = st.groups.filter((g) => g.project_id === sel.p);
  // Scoped to where the boss is standing: inside a project it is that project's
  // queue, on Home it is everything.
  const waiting = countWaiting(st, home ? null : sel.p);
  // Home spans projects, so a timeline there would be cross-project noise while
  // the boss is deciding. It only appears inside a project.
  const showSide = side && !home && st.projects.length > 0;

  const openReq = (grpId: number) => {
    const g = st.groups.find((x) => x.id === grpId);
    go({ p: g?.project_id ?? sel.p, view: "progress", g: grpId });
  };

  // No badge on 概览: the header already carries that count, and two copies of one
  // number is how a reader stops trusting either.
  const VIEWS: [View, string][] = [
    ["board", "概览"],
    ["progress", "进展"],
    ["desk", "工位墙"],
    ["owns", "所有权"],
    ["cost", "成本"],
  ];

  return (
    <TipRoot>
      <Toaster position="bottom-right" theme="system" />
      <AskHost />
      <Picker open={picking} onOpenChange={setPicking} onAdded={refresh} />
      {sel.p && (
        <NewRequirement open={adding} onOpenChange={setAdding} projectId={sel.p} onDone={refresh} />
      )}

      {/*
        The bar carries what the boss acts on, and nothing that is merely true.
        Total spend was there and belongs in 成本, where it can be attributed; a
        green "live" dot that is green all day teaches the eye to skip the corner
        it lives in, so connection state only appears when it is broken.
      */}
      <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-rule bg-rail px-6 py-1.5">
        <button
          className="cursor-pointer font-display text-[1.0625rem] font-semibold"
          onClick={() => go({ view: "home", p: null, g: null })}
        >
          orchestrator
        </button>
        {!home && (
          <span className="flex min-w-0 items-baseline gap-2 text-[0.8125rem]">
            <span className="text-ink-3">/</span>
            <span className="truncate font-display text-[1rem] font-semibold">{proj!.name}</span>
            <Switcher
              projects={st.projects}
              waiting={(id) => countWaiting(st, id)}
              onPick={(id) => go({ p: id, g: null, view: "board" })}
            />
          </span>
        )}
        <span className="grow" />
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
            等你 {waiting}
          </Button>
        ) : (
          <span className="font-mono text-[0.6875rem] text-ink-3">无待办</span>
        )}
        {sel.p && !!st.projects.length && (
          <Button size="sm" onClick={() => setAdding(true)}>＋ 新需求</Button>
        )}
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
        <ThemeToggle />
      </header>

      {!home && (
        <nav className="sticky top-9 z-9 flex gap-5 overflow-x-auto border-b border-rule bg-rail px-6">
          {VIEWS.map(([k, zh]) => (
            <button
              key={k}
              onClick={() => go({ view: k, g: k === "progress" ? sel.g : null })}
              className={cn(
                "-mb-px cursor-pointer whitespace-nowrap border-b-2 py-2 text-[0.8125rem] transition-colors",
                sel.view === k ? "border-accent font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink",
              )}
            >
              {zh}
            </button>
          ))}
        </nav>
      )}

      <main className={cn("grid", showSide ? "grid-cols-[minmax(0,1fr)_20rem] max-[64rem]:grid-cols-1" : "grid-cols-1")}>
        <div className="max-w-[76rem] px-6 pb-24 pt-6">
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
            <Home st={st} onEnter={(p) => go({ p, view: "board", g: null })} onOpen={openReq}
                  onAdd={() => setPicking(true)} refresh={refresh} />
          ) : sel.view === "board" ? (
            <>
              <Queue st={st} projectId={sel.p} onOpen={openReq} refresh={refresh} />
              {groups.length ? (
                <Pipeline st={st} groups={groups} onOpen={openReq} />
              ) : (
                <Card>
                  <CardBody>
                    <CardTitle>还没有需求</CardTitle>
                    <div className="mt-1 text-[0.75rem] text-ink-3">
                      写一句话就行。Dispatcher 深挖、Architect 划边界，拆成计划卡再回来给你批 —— 20 秒。
                    </div>
                    <Button variant="go" className="mt-3" onClick={() => setAdding(true)}>＋ 新需求</Button>
                  </CardBody>
                </Card>
              )}
              <Delivered st={st} projectId={sel.p!} />
            </>
          ) : sel.view === "progress" ? (
            <>
              {sel.g && (
                <Button variant="quiet" className="mb-4" onClick={() => go({ view: "board", g: null })}>
                  ← 返回概览
                </Button>
              )}
              {(sel.g ? groups.filter((g) => g.id === sel.g) : groups).map((g) => (
                <Requirement key={g.id} st={st} g={g} refresh={refresh} open={!!sel.g} />
              ))}
              {!groups.length && <div className="text-[0.75rem] text-ink-3">该项目暂无需求。</div>}
            </>
          ) : sel.view === "desk" ? (
            <Desk st={st} frames={frames} projectId={sel.p!} />
          ) : sel.view === "owns" ? (
            <Owns st={st} projectId={sel.p!} />
          ) : (
            <CostView st={st} cost={cost} projectId={sel.p!} />
          )}
          </Boundary>
        </div>
        {showSide && (
          <aside className="overflow-hidden border-l border-rule">
            <div className="px-4 pb-24 pt-4">
              <Timeline st={st} frames={frames} grpId={sel.g} projectId={sel.p} />
            </div>
          </aside>
        )}
      </main>
    </TipRoot>
  );

}
