import { useTransition } from "react";
import { useTranslation } from "react-i18next";
import { Head } from "../../ui/bits";
import { Button } from "../../ui/button";
import { ask } from "../../ui/confirm";
import { api, mutate } from "../../shared/api";
import { Gates, Sandbox, type ProjectConfig, type ProjectPatch } from "../project/view";

export type ProjectSection = "gates" | "sandbox" | "remove";

export function ProjectPane({
  section,
  data,
  busy,
  projectId,
  projectName,
  groupCount,
  patch,
  onRemoved,
}: {
  section: ProjectSection;
  data: ProjectConfig;
  busy: boolean;
  projectId: number;
  projectName?: string;
  groupCount: number;
  patch: (body: ProjectPatch) => void;
  onRemoved: () => void;
}) {
  if (section === "gates") return <Gates d={data} patch={patch} />;
  if (section === "sandbox") return <Sandbox d={data} busy={busy} patch={patch} />;
  return (
    <Remove
      projectId={projectId}
      name={projectName ?? data.repoPath}
      repoPath={data.repoPath}
      groups={groupCount}
      onRemoved={onRemoved}
    />
  );
}

/**
 * The one irreversible thing in this dialog, and the only place in the panel that
 * deletes rather than archives.
 *
 * 不做了 winds a requirement up and keeps every event, because what a group did is
 * the record. Removing a project is the boss saying they do not want the record
 * either — a different act, so it lives on its own page, behind its own confirm, in
 * the danger colour, and never next to a switch somebody flips while working.
 */
/**
 * The confirm carries what it costs: how many requirements go with it, and — the
 * one thing a boss would be right to fear — that nothing on GitHub is touched. The
 * branches and PRs stay exactly where they are.
 */
function Remove({
  projectId,
  name,
  repoPath,
  groups,
  onRemoved,
}: {
  projectId: number;
  name: string;
  repoPath: string;
  groups: number;
  onRemoved: () => void;
}) {
  const { t } = useTranslation();
  const [busy, startTransition] = useTransition();
  const go = async () => {
    const yes = await ask({
      title: t("settings.project.removeConfirmTitle", { name }),
      body: t("settings.project.removeConfirmBody", { repoPath, groups }),
      yes: t("settings.project.removeConfirmYes"),
      danger: true,
    });
    if (!yes) return;
    // The confirm stays outside the transition: nothing is in flight while the
    // boss reads it, and a button that goes pending on being asked has answered
    // for them.
    startTransition(async () => {
      const r = await mutate(api.projects[":id"].$delete({ param: { id: String(projectId) } }));
      if (r.ok) onRemoved();
    });
  };

  return (
    <>
      <Head title={t("settings.project.removeTitle")} />
      {/* Two columns, one measure: what goes, what stays. It was one paragraph of
          running prose across the full panel, and a destructive decision read as
          an essay puts all the weight on the button being red. The confirm still
          says it in sentences — this is the part you scan before clicking. */}
      {/* Same left edge as every field row in the dialog: the boss arrives here
          from a pane of labelled values, and a column that moves between panes
          is the one thing a fixed grid is for. */}
      <dl className="grid max-w-[34rem] grid-cols-[var(--label)_minmax(0,1fr)] gap-x-4 gap-y-3 pt-1 text-[0.8125rem]">
        <dt className="font-semibold text-bad">{t("settings.project.deleteLabel")}</dt>
        <dd className="min-w-0">
          <span className="font-mono text-[0.75rem]">{repoPath}</span>
          {t("settings.project.deleteCount", { count: groups })}
          <div className="mt-0.5 text-[0.75rem] text-ink-3">{t("settings.project.deleteDetailNote")}</div>
        </dd>
        <dt className="font-semibold text-ok">{t("settings.project.keepLabel")}</dt>
        <dd className="min-w-0 text-ink-2">
          {t("settings.project.keepDetail")}
          {/* 不做了 archives and keeps every event. This does not, and the two
              buttons are one dialog apart. */}
          <div className="mt-0.5 text-[0.75rem] text-ink-3">{t("settings.project.keepDetailNote")}</div>
        </dd>
      </dl>
      <Button variant="danger" className="mt-5" disabled={busy} onClick={go}>
        {busy ? t("settings.project.removing") : t("settings.project.removeButton")}
      </Button>
    </>
  );
}
