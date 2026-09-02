import { z } from "zod";
import type { State } from "../../shared/api";
import { SectionSchema, type Section } from "../settings/model";
import { msg, t } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

const ViewSchema = z.enum([
  "home",
  "board",
  "progress",
  "req",
  "desk",
  "owns",
  "cost",
  "notes",
  "time",
  "settings",
  "config",
  "skills",
  "github",
  "sandbox",
]);
export type View = z.infer<typeof ViewSchema>;

export interface Selection {
  p: number | null;
  view: View;
  g: number | null;
  t: string | null;
  s: Section | null;
}

export type ContentSlot =
  | "first"
  | "home"
  | "progress"
  | "empty"
  | "req"
  | "missing"
  | "desk"
  | "notes"
  | "owns"
  | "time"
  | "cost";
export type Shortcut = "toggle-side" | "settings" | "project-picker" | "requirement-picker";

const HashId = z.union([z.coerce.number().int().positive(), z.null()]).catch(null);
const DIALOG: Partial<Record<View, Section>> = {
  settings: "cred",
  config: "gates",
  skills: "skills",
  github: "github",
  sandbox: "sandbox",
};

export const VIEWS: [View, MessageDescriptor][] = [
  ["progress", msg`Ticket`],
  ["desk", msg`Desk wall`],
  ["notes", msg`Notes`],
  ["owns", msg`Ownership`],
  ["cost", msg`Cost`],
  // Top level, beside the other four. It was a tab inside `Requirement`, one rank down,
  // which put "where did this project's wall clock go" underneath "which
  // requirements are running" — but a project's spans are every route and
  // container operation that named it, most of them belonging to no requirement
  // at all. It is a sibling question, not a detail of that one.
  ["time", msg`Time`],
];

export const choose = <T>(condition: boolean, yes: T, no: T): T => (condition ? yes : no);
export const idOrZero = (id: number | null): number => id ?? 0;
/** The id of a row that was looked up, or null when the lookup found nothing —
 *  which is the difference between "this project" and "no project", and the one
 *  `SettingsDialog` needs so it does not ask about an id the snapshot lacks. */
export const idOrNull = (item: { id: number } | undefined): number | null => item?.id ?? null;
export const orEmpty = <T>(values: T[] | null | undefined): T[] => values ?? [];
export const findById = <T extends { id: number }>(id: number | null, values: T[]): T | undefined =>
  values.find((value) => value.id === id);
export const projectForGroup = (group: { project_id: number } | undefined, fallback: number | null): number | null =>
  group?.project_id ?? fallback;
export const settingsInitial = (selected: Section | null, section: Section | null): Section =>
  selected ?? section ?? "cred";
export const projectNameProps = (project: { name: string } | undefined): { projectName?: string } =>
  project ? { projectName: project.name } : {};
export const itemName = (item: { name: string } | undefined): string => item?.name ?? "";
export const showRequirementCrumb = (view: View, hasGroup: boolean): boolean => view === "req" && hasGroup;
export const showNewRequirement = (project: number | null, projectCount: number): boolean =>
  !!project && projectCount > 0;
export const isHome = (view: View, hasProject: boolean): boolean => view === "home" || !hasProject;
export const showSide = (side: boolean, home: boolean, projects: number): boolean => side && !home && projects > 0;
export const waitingProject = (home: boolean, project: number | null): number | null => (home ? null : project);
export const viewActive = (view: View, candidate: View): boolean =>
  view === candidate || (view === "req" && candidate === "progress");
export const viewClass = (active: boolean): string =>
  active ? "border-accent font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink";
export const connectionText = (live: string): string =>
  live === "retry" ? t`Connection lost; reconnecting` : t`Connecting`;
export const sideText = (side: boolean): string =>
  side ? t`Collapse event stream` : t`Expand event stream: who said what to whom, newest first`;
export const sideClass = (side: boolean): string => (side ? "text-ink" : "text-ink-3 hover:text-ink");
export const settingsClass = (active: boolean): string => (active ? "text-ink" : "text-ink-3 hover:text-ink");
export const scrollClass = (view: View): string =>
  ["cost", "owns", "desk", "notes", "progress", "req", "time"].includes(view)
    ? "overflow-hidden pb-4"
    : "overflow-y-auto pb-16";
export const bodyClass = (side: boolean): string => (side ? "flex max-[64rem]:block" : "block");
export const readSide = (storage: Pick<Storage, "getItem">): boolean => {
  try {
    return storage.getItem("orch.side") !== "0";
  } catch {
    return true;
  }
};

export function parseSelection(hash: string): Selection {
  const value = new URLSearchParams(hash.replace(/^#/, ""));
  return {
    p: HashId.parse(value.get("p")),
    view: ViewSchema.catch("home").parse(value.get("v")),
    g: HashId.parse(value.get("g")),
    t: value.get("t"),
    s: SectionSchema.nullable().catch(null).parse(value.get("s")),
  };
}

/**
 * The next selection, given a patch. One rule lives here: a tab belongs to the
 * view it was opened in, so changing view drops it.
 *
 * In the model rather than at the callers because the callers are where it kept
 * being forgotten — the header's buttons pass `t: null` by hand and the host
 * banner's "fix this" did not, which left `#v=settings&t=done&s=server` in the
 * bar, naming a tab the settings view does not have. A patch that says what `t`
 * should be still wins: it is applied last.
 */
export const nextSelection = (current: Selection, patch: Partial<Selection>): Selection => ({
  ...current,
  ...(patch.view && patch.view !== current.view ? { t: null } : {}),
  ...patch,
});

export function selectionHash(selection: Selection): string {
  const value = new URLSearchParams();
  if (selection.p) value.set("p", String(selection.p));
  value.set("v", selection.view);
  if (selection.g) value.set("g", String(selection.g));
  if (selection.t) value.set("t", selection.t);
  if (selection.s) value.set("s", selection.s);
  return `#${value}`;
}

export function backgroundView(selection: Pick<Selection, "g" | "view">): View | null {
  const view = selection.view === "board" ? "progress" : selection.view;
  if (DIALOG[view]) return null;
  return view === "progress" && selection.g ? "req" : view;
}

export function resolveNavigation(selection: Selection, behind: View) {
  const asked = selection.view === "board" ? "progress" : selection.view;
  const section = DIALOG[asked] ?? null;
  return { section, view: section ? behind : asked === "progress" && selection.g ? "req" : asked };
}

export function repairMissingGroup(group: number | null, ids: number[]): Partial<Selection> | null {
  if (!group || ids.length === 0 || ids.includes(group)) return null;
  return { g: null, view: "progress", t: null };
}

/**
 * The same repair for the project in the hash, and it cannot share the group's
 * guard.
 *
 * `repairMissingGroup` reads an empty list as "not loaded yet", which is right
 * there: a project with no requirements is reached through the picker, not
 * through a stale link. For projects an empty list is genuinely ambiguous — a
 * fresh install has none — so the caller says whether the snapshot has arrived.
 */
/**
 * Without this, an `#p=` from a previous database reached `SettingsDialog`, the
 * one consumer that takes `sel.p` raw rather than the looked-up project, and
 * every focus of the window asked for a project that is not there. `readApi`
 * records a 404 as a *successful* read of `null`, so there is no error state to
 * de-duplicate against: a fresh English toast each time, over a dialog whose
 * Gates and Sandbox panes sit at `Loading…` for good.
 */
export function repairMissingProject(
  project: number | null,
  ids: number[],
  loaded: boolean,
): Partial<Selection> | null {
  if (!project || !loaded || ids.includes(project)) return null;
  return { p: null, g: null, view: "home", t: null };
}

/**
 * Both repairs, asked once.
 *
 * The project first: dropping it clears the group as well, so running the group
 * rule against the same render would be a second answer to a question already
 * settled. One call also keeps `App` from growing a branch per rule — the shell
 * is the most-read function in the panel and the audit gates its complexity.
 */
export function repairSelection(
  selection: Pick<Selection, "g" | "p">,
  ids: { groups: number[]; projects: number[] },
  loaded: boolean,
): Partial<Selection> | null {
  return repairMissingProject(selection.p, ids.projects, loaded) ?? repairMissingGroup(selection.g, ids.groups);
}

export function navigationShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">,
  selection: Pick<Selection, "g" | "view">,
): Shortcut | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const direct: Partial<Record<string, Shortcut>> = { b: "toggle-side", s: "settings" };
  if (event.key !== "k") return direct[event.key] ?? null;
  return selection.view === "req" && selection.g ? "requirement-picker" : "project-picker";
}

export function contentSlot(
  projects: number,
  home: boolean,
  view: View,
  groups: number,
  delivered: boolean,
  hasGroup: boolean,
): ContentSlot {
  if (projects === 0) return "first";
  if (home) return "home";
  if (view === "progress") return groups > 0 || delivered ? "progress" : "empty";
  if (view === "req") return hasGroup ? "req" : "missing";
  const direct: Partial<Record<View, ContentSlot>> = { desk: "desk", notes: "notes", owns: "owns", time: "time" };
  return direct[view] ?? "cost";
}

export function projectItem(project: State["projects"][number], waiting: number) {
  const same = project.repo_path.split("/").at(-1) === project.name;
  return {
    id: project.id,
    name: same ? project.repo_path : project.name,
    ...(same ? {} : { meta: project.repo_path }),
    rtlMeta: true,
    ...(waiting > 0 ? { badge: t`${waiting} to do` } : {}),
  };
}

export function requirementItem(group: State["groups"][number], status: string) {
  return { id: group.id, name: group.name, meta: `${status}${group.branch ? ` · ${group.branch}` : ""}` };
}

/**
 * What identifies the content subtree, for the error boundary's `key`.
 *
 * A `key` change unmounts and remounts everything under it — the right tool for
 * "this is a different page now, discard its state" and a trap everywhere else.
 */
/**
 * It takes the **resolved** view, not `selection.view`, and that is the whole fix.
 * The raw value becomes `settings` the moment a dialog opens, so keying on it threw
 * away the page *behind* the dialog and rebuilt it: on `Time` both charts and the table
 * vanished and came back as the modal appeared, each re-reading its endpoint.
 *
 * The project and the group stay in the key because those really are different
 * pages: a boundary holding an error for one requirement should not keep showing it
 * for the next.
 */
export const contentKey = (view: View, project: number | null, group: number | null): string =>
  `${view}:${project}:${group}`;
