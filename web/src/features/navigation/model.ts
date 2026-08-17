import { z } from "zod";
import type { State } from "../../lib/api";
import { SectionSchema, type Section } from "../../views/settings";

const ViewSchema = z.enum([
  "home",
  "board",
  "progress",
  "req",
  "desk",
  "owns",
  "cost",
  "notes",
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

export const VIEWS: [View, string][] = [
  ["progress", "需求"],
  ["desk", "工位墙"],
  ["notes", "记录"],
  ["owns", "所有权"],
  ["cost", "成本"],
];

export const choose = <T>(condition: boolean, yes: T, no: T): T => (condition ? yes : no);
export const idOrZero = (id: number | null): number => id ?? 0;
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
export const connectionText = (live: string): string => (live === "retry" ? "连接断了，重连中" : "连接中");
export const sideText = (side: boolean): string => (side ? "收起事件流" : "展开事件流：谁跟谁说了什么，按时间倒序");
export const sideClass = (side: boolean): string => (side ? "text-ink" : "text-ink-3 hover:text-ink");
export const settingsClass = (active: boolean): string => (active ? "text-ink" : "text-ink-3 hover:text-ink");
export const scrollClass = (view: View): string =>
  ["cost", "owns", "desk", "notes", "progress", "req"].includes(view)
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
  const direct: Partial<Record<View, ContentSlot>> = { desk: "desk", notes: "notes", owns: "owns" };
  return direct[view] ?? "cost";
}

export function projectItem(project: State["projects"][number], waiting: number) {
  const same = project.repo_path.split("/").at(-1) === project.name;
  return {
    id: project.id,
    name: same ? project.repo_path : project.name,
    ...(same ? {} : { meta: project.repo_path }),
    rtlMeta: true,
    ...(waiting > 0 ? { badge: `${waiting} 件待办` } : {}),
  };
}

export function requirementItem(group: State["groups"][number], status: string) {
  return { id: group.id, name: group.name, meta: `${status}${group.branch ? ` · ${group.branch}` : ""}` };
}
