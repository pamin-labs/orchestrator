import { useCallback, useEffect, useMemo, useState } from "react";
import { Head, Input, Meta } from "../../ui/bits";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { api, mutate, readApi } from "../../shared/api";
import { searchSkills, skillTally } from "./model";
import { forgetSkills } from "../composer/view";
import { cn } from "../../ui/cn";
import { z } from "zod";
import { SkillSchema, type Skill as Row } from "../composer/view";
import { skillsQuery } from "../composer/model";

/**
 * Which of the boss's skills the agents can see.
 *
 * A ticked skill is copied into the one directory every sandbox mounts read-only,
 * so an agent finds and invokes it by itself. That reach is not free: every ticked
 * skill's name and description sit in the cached prefix of EVERY turn of EVERY
 * agent, which is why the count and the estimate are stated above the list rather
 * than discovered on the bill. Unticking one does not hide it from the boss — a
 * skill named in a requirement is still injected into that single turn.
 *
 * Project skills have no tick box: they live in the checkout the CLI already runs
 * in, so they are visible whatever this page says.
 */

export function Skills({ projectId }: { projectId: number | null }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await readApi(
      api.skills.$get({ query: skillsQuery(projectId) }),
      z.object({ skills: z.array(SkillSchema) }),
    );
    setRows(d?.skills ?? []);
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const tally = useMemo(() => skillTally(rows ?? []), [rows]);
  const shown = useMemo(() => searchSkills(rows ?? [], q), [rows, q]);

  const toggle = async (r: Row) => {
    setBusy(r.name);
    // Optimistic: the staging copy takes a moment on a big skill and a tick box
    // that waits for a filesystem walk reads as a dead control.
    setRows((all) => (all ?? []).map((x) => (x.name === r.name ? { ...x, on: !x.on } : x)));
    await mutate(api.skills.$post({ json: { name: r.name, on: !r.on } }));
    forgetSkills();
    setBusy(null);
  };

  // The project goes with it: this page is machine-scope, but half of what it
  // lists ships with the repository a project's containers hold, and the server
  // has to be told whose to ask.
  const rescan = async () => {
    setBusy("*");
    await mutate(api.skills.$post({ json: projectId ? { project: projectId } : {} }));
    await load();
    setBusy(null);
  };

  return (
    <>
      <Head
        title="技能"
        note={
          rows
            ? `勾中的 ${tally.staged}/${tally.user} 个进沙盒` +
              (tally.repo ? `，仓库自带 ${tally.repo} 个` : "") +
              `，每 turn 前缀约 ${tally.k}k tokens`
            : "读取中…"
        }
      >
        <Button variant="quiet" size="sm" disabled={busy === "*"} onClick={rescan}>
          重新扫描
        </Button>
      </Head>

      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜技能"
        className="mb-2"
        aria-label="搜技能"
      />

      <div className="divide-y divide-rule-soft">
        {shown.map((r) => {
          const fixed = r.scope === "project";
          return (
            <label
              key={r.path}
              className={cn("flex items-baseline gap-2 py-1.5", fixed ? "cursor-default" : "cursor-pointer")}
            >
              {/* A project skill had a ticked, disabled box — the one shape in this
                  list that means "broken", used for the one row that is always on.
                  It gets no control at all, and the marker says why. The slot stays
                  the box's width so the names still line up. */}
              {fixed ? (
                <span className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <input
                  type="checkbox"
                  checked={r.on}
                  disabled={busy === r.name}
                  onChange={() => void toggle(r)}
                  className="size-3.5 shrink-0 self-center accent-[var(--accent)] disabled:opacity-40"
                />
              )}
              <span className="font-mono text-[0.75rem] text-ink">{r.name}</span>
              {/* Only the exception is marked. 全局 on every other row was a word
                  repeated a hundred and seventy-eight times to say "normal". */}
              {fixed && <Badge className="shrink-0 self-center">随仓库</Badge>}
              <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-ink-3">{r.description}</span>
            </label>
          );
        })}
        {rows && !shown.length && <Meta className="block py-2">没有匹配的技能</Meta>}
      </div>
    </>
  );
}
