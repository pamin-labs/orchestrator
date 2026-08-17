import { homeRows, projectRow } from "../features/home/model";
import type { State } from "../lib/api";
import { cn } from "../lib/utils";
import { H2, Meta } from "../ui/bits";
import { Button } from "../ui/button";
import { cardStyles } from "../ui/card";
import { Queue } from "./queue";

/**
 * Every project at once, plus what wants the boss across all of them.
 *
 * "谁在等我" does not care which project it is in, so the queue spans them and each
 * row names its own. Entering a project is a deliberate step. No timeline here:
 * cross-project chatter is noise while deciding.
 *
 * The rows are held to a measure. Three short facts stretched across a 76rem shell
 * put 个需求 and tokens — the two least important things on the page — at the far
 * right edge, which is the strongest position a row has, and left the eye no reason
 * to land on the name.
 */
export function Home({
  st,
  onEnter,
  onOpen,
  onNew,
  onAdd,
  refresh,
}: {
  st: State;
  onEnter: (p: number) => void;
  onOpen: (grpId: number) => void;
  onNew: (p: number) => void;
  onAdd: () => void;
  refresh: () => void;
}) {
  // 都处理完了 reports on work that got processed. With no requirement anywhere
  // there is none, and a green line claiming otherwise is the first thing a fresh
  // install reads.
  const anyWork = st.groups.length > 0;
  return (
    <>
      {anyWork && <Queue st={st} projectId={null} onOpen={onOpen} refresh={refresh} />}
      <div className="max-w-[44rem]">
        <H2 className={cn(anyWork && "mt-9")}>项目</H2>
        <div className="flex flex-col gap-2.5">
          {homeRows(st).map((p) => {
            const { n, state, bits, live, meta } = projectRow(st, p.id);
            return (
              <div
                key={p.id}
                className={cn(
                  cardStyles({ tone: n ? "mine" : "default" }),
                  "relative grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-5 gap-y-2 p-3.5 transition-colors",
                  // Same focus vocabulary as every input here: accent border, soft ring.
                  "focus-within:border-accent",
                  !n && "hover:border-ink-3",
                )}
              >
                <div className="min-w-0">
                  {/* The whole card is the target, but a fresh project carries its own
                      action inside it, and a button inside a button is not a thing the
                      DOM has. The name owns the card via a stretched pseudo-element. */}
                  <button
                    type="button"
                    onClick={() => onEnter(p.id)}
                    className={cn(
                      "cursor-pointer text-left font-display text-[1.0625rem] font-semibold",
                      "after:absolute after:inset-0 after:rounded-xl",
                      "focus-visible:outline-none focus-visible:after:ring-3 focus-visible:after:ring-accent-soft",
                    )}
                  >
                    {p.name}
                  </button>
                  <div className="mt-px truncate font-mono text-[0.6875rem] text-ink-3">{p.repo_path}</div>
                  {n ? (
                    <div className="mt-1 text-[0.8125rem] font-semibold text-accent">{bits.join(" · ")}</div>
                  ) : (
                    // 空着 is said by the button beside it, in a form you can act on.
                    !state.fresh && <div className="mt-1 text-[0.75rem] text-ink-3">{state.zh}</div>
                  )}
                  {live.length > 0 && (
                    <div className="mt-1.5 truncate text-[0.75rem] text-ink-2">在跑：{live.join("、")}</div>
                  )}
                </div>
                {state.fresh ? (
                  // Nothing has ever been asked of this project, so the row is where to
                  // ask. `relative` puts it above the stretched name, not on it.
                  <Button className="relative" onClick={() => onNew(p.id)}>
                    ＋ 新需求
                  </Button>
                ) : (
                  meta.length > 0 && <Meta className="whitespace-nowrap">{meta.join(" · ")}</Meta>
                )}
              </div>
            );
          })}
        </div>
        {/* Adding a project happens once. It does not outrank the rows it adds to. */}
        <Button variant="quiet" className="mt-2.5" onClick={onAdd}>
          ＋ 添加项目
        </Button>
      </div>
    </>
  );
}
