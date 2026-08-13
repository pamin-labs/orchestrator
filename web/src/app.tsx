import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { Button } from "./ui/button";
import { AskHost } from "./ui/confirm";
import { Switcher } from "./ui/switcher";
import { post, useOrch } from "./lib/api";
import { countWaiting } from "./lib/select";
import { cn, money } from "./lib/utils";
import { Home } from "./views/home";
import { NewRequirement } from "./views/newreq";
import { Picker } from "./views/picker";
import { Pipeline } from "./views/pipeline";
import { Queue } from "./views/queue";
import { Requirement } from "./views/requirement";
import { Timeline } from "./views/timeline";
import { CostView, Desk, Owns } from "./views/tables";

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

  useEffect(() => {
    const h = new URLSearchParams();
    if (sel.p) h.set("p", String(sel.p));
    h.set("v", sel.view);
    if (sel.g) h.set("g", String(sel.g));
    history.replaceState(null, "", `#${h}`);
  }, [sel]);
  useEffect(() => {
    const onHash = () => setSel(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const proj = st.projects.find((p) => p.id === sel.p);
  const home = sel.view === "home" || !proj;
  const groups = st.groups.filter((g) => g.project_id === sel.p);
  const usd = st.groups.reduce((n, g) => n + (g.spent_usd || 0), 0);
  // Home spans projects, so a timeline there would be cross-project noise while
  // the boss is deciding. It only appears inside a project.
  const showSide = side && !home && st.projects.length > 0;

  const openReq = (grpId: number) => {
    const g = st.groups.find((x) => x.id === grpId);
    go({ p: g?.project_id ?? sel.p, view: "progress", g: grpId });
  };

  const VIEWS: [View, string, number][] = [
    ["board", "概览", countWaiting(st, sel.p)],
    ["progress", "进展", 0],
    ["desk", "工位墙", 0],
    ["owns", "所有权", 0],
    ["cost", "成本", 0],
  ];

  return (
    <>
      <Toaster position="bottom-right" theme="system" />
      <AskHost />
      <Picker open={picking} onOpenChange={setPicking} onAdded={refresh} />
      {sel.p && (
        <NewRequirement open={adding} onOpenChange={setAdding} projectId={sel.p} onDone={refresh} />
      )}

      <header className="sticky top-0 z-10 flex items-baseline gap-4.5 border-b border-rule bg-rail px-6 py-2">
        <b
          className="cursor-pointer font-display text-[1.0625rem] font-semibold"
          onClick={() => go({ view: "home", p: null, g: null })}
        >
          orchestrator
        </b>
        {!home && (
          <span className="flex items-baseline gap-2 text-[0.8125rem]">
            <span className="text-ink-3">/</span>
            <span className="font-display text-[1rem] font-semibold">{proj!.name}</span>
            <Switcher
              projects={st.projects}
              waiting={(id) => countWaiting(st, id)}
              onPick={(id) => go({ p: id, g: null, view: "board" })}
            />
          </span>
        )}
        <span className="grow" />
        {usd > 0 && <span className="font-mono text-[0.6875rem] text-ink-3">{money(usd)}</span>}
        {!home && (
          <Button variant="quiet" size="sm" onClick={() => setSide((v) => !v)}>事件流</Button>
        )}
        <span className="flex items-center gap-1.5 font-mono text-[0.6875rem] text-ink-3">
          <i className={cn(
            "size-1.5 rounded-full transition-colors",
            live === "live" && "breathe bg-ok", live === "retry" && "bg-warn", live === "connecting" && "bg-ink-3",
          )} />
          {live === "live" ? "live" : live === "retry" ? "重连中" : "connecting"}
        </span>
      </header>

      {!home && (
        <nav className="sticky top-10 z-9 flex gap-6 border-b border-rule bg-rail px-6">
          {VIEWS.map(([k, zh, n]) => (
            <button
              key={k}
              onClick={() => go({ view: k, g: k === "progress" ? sel.g : null })}
              className={cn(
                "-mb-px cursor-pointer border-b-2 py-2 text-[0.8125rem] transition-colors",
                sel.view === k ? "border-accent font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink",
              )}
            >
              {zh}
              {n > 0 && <span className="ml-1 font-mono text-[0.6875rem] text-accent">{n}</span>}
            </button>
          ))}
        </nav>
      )}

      <main className={cn("grid", showSide ? "grid-cols-[minmax(0,1fr)_20rem] max-[64rem]:grid-cols-1" : "grid-cols-1")}>
        <div className="max-w-[76rem] px-6 pb-24 pt-6">
          {!st.projects.length ? (
            <div className="max-w-[40rem] rounded-lg border border-rule p-4">
              <b className="font-display text-[1.0625rem] font-semibold">添加项目</b>
              <div className="mb-3 mt-1 text-[0.75rem] text-ink-3">
                本地 git 仓库。注册时自动检测测试命令与 PR 权限。
              </div>
              <Button variant="go" onClick={() => setPicking(true)}>挑文件夹…</Button>
            </div>
          ) : home ? (
            <Home st={st} onEnter={(p) => go({ p, view: "board", g: null })} onOpen={openReq}
                  onAdd={() => setPicking(true)} refresh={refresh} />
          ) : sel.view === "board" ? (
            <>
              <div className="mb-4 flex items-center gap-2">
                <Button variant="go" onClick={() => setAdding(true)}>＋ 新需求</Button>
                <span className="text-[0.75rem] text-ink-3">
                  {groups.length ? `${groups.length} 个需求` : "无需求"}
                </span>
              </div>
              <Queue st={st} projectId={sel.p} onOpen={openReq} refresh={refresh} />
              <Pipeline st={st} groups={groups} onOpen={openReq} />
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
            <Desk st={st} projectId={sel.p!} />
          ) : sel.view === "owns" ? (
            <Owns st={st} projectId={sel.p!} />
          ) : (
            <CostView st={st} cost={cost} projectId={sel.p!} />
          )}
        </div>
        {showSide && (
          <aside className="overflow-hidden border-l border-rule">
            <div className="px-4 pb-24 pt-4">
              <Timeline st={st} frames={frames} grpId={sel.g} projectId={sel.p} />
            </div>
          </aside>
        )}
      </main>
    </>
  );

}
