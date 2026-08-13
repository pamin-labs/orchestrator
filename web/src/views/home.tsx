import { Button } from "../ui/button";
import { H2, Meta } from "../ui/bits";
import type { State } from "../lib/api";
import { countWaiting, pending, projectState } from "../lib/select";
import { cn, money } from "../lib/utils";
import { Queue } from "./queue";

/**
 * Every project at once, plus what wants the boss across all of them.
 *
 * "谁在等我" does not care which project it is in, so the queue spans them and each
 * row names its own. Entering a project is a deliberate step. No timeline here:
 * cross-project chatter is noise while deciding.
 */
export function Home({
  st, onEnter, onOpen, onAdd, refresh,
}: {
  st: State;
  onEnter: (p: number) => void;
  onOpen: (grpId: number) => void;
  onAdd: () => void;
  refresh: () => void;
}) {
  const rows = [...st.projects].sort((a, b) => countWaiting(st, b.id) - countWaiting(st, a.id));
  return (
    <>
      <Queue st={st} projectId={null} onOpen={onOpen} refresh={refresh} showProject />
      <H2 className="mt-9">
        项目 <span className="font-normal tracking-normal text-ink-3">{st.projects.length}</span>
      </H2>
      {rows.map((p) => {
        const w = pending(st, p.id);
        const n = countWaiting(st, p.id);
        const gs = st.groups.filter((g) => g.project_id === p.id);
        const live = gs.filter((g) => ["RUNNING", "PLANNING"].includes(g.status));
        const usd = gs.reduce((x, g) => x + (g.spent_usd || 0), 0);
        const bits = [
          w.cards.length && `${w.cards.length} 张卡待批`,
          w.slices.length && `${w.slices.length} 片待查收`,
          w.merges.length && `${w.merges.length} 个待合入`,
          w.asks.length && `${w.asks.length} 个提问`,
        ].filter(Boolean);
        return (
          <button
            key={p.id}
            onClick={() => onEnter(p.id)}
            className={cn(
              "mb-2.5 grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-5 gap-y-2 rounded-lg border p-3.5 text-left transition-colors",
              n ? "border-accent bg-accent-soft" : "border-rule bg-paper hover:border-ink-3",
            )}
          >
            <div className="min-w-0">
              <div className="font-display text-[1.0625rem] font-semibold">{p.name}</div>
              <div className="mt-px truncate font-mono text-[0.6875rem] text-ink-3">{p.repo_path}</div>
              {n ? (
                <div className="mt-1 text-[0.8125rem] font-semibold text-accent">{bits.join(" · ")}</div>
              ) : (
                <div className="mt-1 text-[0.75rem] text-ink-3">{projectState(st, p.id).zh}</div>
              )}
              {live.length > 0 && (
                <div className="mt-1.5 truncate text-[0.75rem] text-ink-2">
                  在跑：{live.map((g) => g.name).join("、")}
                </div>
              )}
            </div>
            <div className="whitespace-nowrap text-right">
              <Meta>{gs.length} 个需求</Meta>
              <br />
              <Meta>{usd ? money(usd) : "$0.00"}</Meta>
            </div>
          </button>
        );
      })}
      <Button className="mt-2" onClick={onAdd}>＋ 添加项目</Button>
    </>
  );
}
