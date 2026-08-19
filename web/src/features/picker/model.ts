import i18n from "../../i18n";

/**
 * What the two pickers work out before they draw a row.
 *
 * Both surfaces are lists of one-line rows whose whole content is a decision:
 * which entries a listing shows and in what order, which single fact the right
 * edge of a row is worth spending on, and what a repository row offers when the
 * boss lands on it. All of that was inline in the JSX, where the only way to ask
 * "does a directory that is already a project still say 已添加" was to render a
 * dialog Radix will not render on a server at all.
 */

/** One row of a directory listing. A file has a `size`; a directory has neither. */
export interface Entry {
  name: string;
  path: string;
  repo?: boolean | undefined;
  taken?: boolean | undefined;
  size?: number | undefined;
}

/** What `GET /dirs` says about one directory. */
export interface Listing {
  path: string;
  dirs: Entry[];
  files: Entry[];
}

/**
 * The crumb trail and the rows, directories first.
 *
 * Directories before files because the list is walked, not read: everything that
 * goes anywhere is at the top. Nothing sorts within a kind — the server already
 * sent them in the order it wants.
 */
export function browseListing(dirs: Listing | null): { parts: string[]; rows: [Entry, boolean][] } {
  return {
    parts: (dirs?.path ?? "").split("/").filter(Boolean),
    rows: [
      ...(dirs?.dirs ?? []).map((entry) => [entry, true] as [Entry, boolean]),
      ...(dirs?.files ?? []).map((entry) => [entry, false] as [Entry, boolean]),
    ],
  };
}

/**
 * The one fact the right edge of a row is worth spending on.
 *
 * First match wins, and the order is what the boss is deciding: whether this row
 * is already picked beats whether it is already a project, which beats what kind
 * of thing it is, which beats how big it is. 已添加 outranks git 仓库 because a
 * repository that is already a project is not one you can add again.
 */
export function entryMeta(entry: Entry, selected: boolean, pick: boolean): string {
  const choices: [boolean, string][] = [
    [selected, i18n.t("picker.model.entryMeta.selected", "已选")],
    [!!entry.taken, i18n.t("picker.model.entryMeta.taken", "已添加")],
    [!!entry.repo && !pick, i18n.t("picker.model.entryMeta.repo", "git 仓库")],
    [entry.size != null, `${Math.max(1, Math.round((entry.size ?? 0) / 1024))}k`],
  ];
  return choices.find(([matches]) => matches)?.[1] ?? "";
}

/** The glyph, whether it is the accented one, and the row's right edge. */
export interface RowMarks {
  glyph: string;
  repo: boolean;
  meta: string;
}

/**
 * A repository is marked, and only where the mark means something: picking an
 * attachment, every directory is just one to reach into.
 */
export function browseRow(entry: Entry, isDir: boolean, pick: boolean, selected: boolean): RowMarks {
  const repo = !!entry.repo && !pick;
  return { glyph: repo ? "◆" : isDir ? "▸" : "·", repo, meta: entryMeta(entry, selected, pick) };
}

/** "今天" / "3 天前" / "2 个月前". Age, at the resolution anyone acts on. */
export function days(t: number): string {
  if (!t) return "";
  const d = Math.round((Date.now() - t) / 86_400_000);
  return d < 1
    ? i18n.t("picker.model.days.today", "今天")
    : d < 30
      ? i18n.t("picker.model.days.days", "{{n}} 天前", { n: d })
      : i18n.t("picker.model.days.months", "{{n}} 个月前", { n: Math.round(d / 30) });
}

/** A repository as it is shown by GitHub, and what this panel has done with it. */
export interface RepoLine {
  fullName: string;
  defaultBranch: string;
  pushedAt: number;
  taken: { id: number; name: string } | null;
}

/** Owner dropped, the age or the state, and what pressing the row will do. */
export interface RepoMarks {
  name: string;
  meta: string;
  action: string;
  adding: boolean;
}

/**
 * What one repository row says, in the three places it says something.
 *
 * The owner is dropped: every row is under the account named in the header. One
 * already added goes somewhere rather than doing something — the same row cannot
 * both add and be added.
 */
export function repoRow(repo: RepoLine, busy: string): RepoMarks {
  const adding = busy === repo.fullName;
  return {
    name: repo.fullName.split("/")[1] ?? repo.fullName,
    meta: adding
      ? i18n.t("picker.model.repoRow.adding", "添加中…")
      : repo.taken
        ? i18n.t("picker.model.entryMeta.taken", "已添加")
        : days(repo.pushedAt),
    action: repo.taken
      ? i18n.t("picker.model.repoRow.goTo", "去 {{name}} →", { name: repo.taken.name })
      : i18n.t("picker.model.repoRow.add", "添加 · {{branch}}", { branch: repo.defaultBranch }),
    adding,
  };
}
