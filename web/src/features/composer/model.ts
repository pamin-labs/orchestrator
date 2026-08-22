import { z } from "zod";
import { t } from "@lingui/core/macro";

/** Not exported: the derived types are the contract, this is how they are built. */
const AttachedSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.string(),
  size: z.number(),
  url: z.string().optional(),
  label: z.string(),
});
export type Attached = z.infer<typeof AttachedSchema>;

export const SavedAttachmentSchema = AttachedSchema.omit({ label: true, url: true });
export type SavedAttachment = z.infer<typeof SavedAttachmentSchema>;

export const SkillSchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string(),
  scope: z.enum(["project", "user"]),
  on: z.boolean(),
});
export type Skill = z.infer<typeof SkillSchema>;

/**
 * Absent, not empty, when there is no project.
 *
 * Both callers wrote `String(projectId ?? "")`, which sends `project=`. The
 * server's `.optional()` only short-circuits on an absent value, so an empty
 * string still reached `z.coerce.number()`, became 0, and failed `.positive()`:
 * `Skills` is machine-scope, and it answered a Zod error whenever no project was
 * selected. One builder so a third caller cannot reinvent the empty string.
 */
export const skillsQuery = (projectId?: number | null): { project?: string } =>
  projectId ? { project: String(projectId) } : {};

const DraftAttachmentSchema = AttachedSchema.pick({ name: true, path: true, type: true, label: true });
const DraftSchema = z.object({ text: z.string(), attachments: z.array(DraftAttachmentSchema) });
export type Draft = z.infer<typeof DraftSchema>;

/** A file and where it sat inside whatever was dropped. */
export interface Picked {
  file: File;
  rel: string;
}

/** An open `/` picker: where the slash sits and what has been typed after it. */
export interface Slash {
  from: number;
  q: string;
}

/**
 * The `/` that opens the skill picker, if the caret is sitting after one.
 *
 * A slash only counts at the start of a word — a path typed mid-sentence is not
 * a picker — and with no skills to offer there is nothing to open.
 */
export function slashAt(value: string, caret: number, skills: Skill[] | null): Slash | null {
  const m = /(?:^|\s)\/([\w.:-]*)$/.exec(value.slice(0, caret));
  if (!m || !skills?.length) return null;
  return { from: caret - m[1]!.length - 1, q: m[1]!.toLowerCase() };
}

/** Swap the `/query` that opened the picker for `insert`, leaving the rest of the sentence. */
export const replaceSlash = (text: string, slash: Slash, insert: string): string =>
  text.slice(0, slash.from) + insert + text.slice(slash.from + slash.q.length + 1);

/**
 * What a closed picker offers is nothing, so the caller never asks twice.
 *
 * Named for the slash rather than for skills, because the settings search box
 * has its own `searchSkills` over the same rows and the two are not
 * interchangeable: this one takes the parsed `/` token and answers empty when
 * the picker is closed, the other takes free text and answers everything when
 * the box is empty. Both were called `matchSkills`, which is a barrel re-export
 * away from resolving to the wrong one.
 */
export const skillsForSlash = (skills: Skill[] | null, slash: Slash | null): Skill[] =>
  slash === null
    ? []
    : (skills ?? []).filter(
        (sk) => !slash.q || sk.name.toLowerCase().includes(slash.q) || sk.path.toLowerCase().includes(slash.q),
      );

const kindOf = (type: string) =>
  type === "inode/directory"
    ? t`Folder`
    : type.startsWith("image/")
      ? t({ message: "Image", context: "a picture, not a container image" })
      : t`Attach`;

/**
 * A name for each file, written into the text where it was added.
 *
 * Two screenshots and a sentence saying "this part is wrong" leaves the agent
 * guessing which part — and it cannot ask cheaply, because asking costs the boss a
 * turn in `To do`. So every attachment gets an `Image N` / `Attach N` marker, which goes in at the
 * caret, and the same marker labels the path in the assembled prompt. The text
 * can then say "change [Image 2]", and both ends mean the same file.
 */
export function attachmentLabel(type: string, taken: string[]): string {
  const kind = kindOf(type);
  return `${kind}${taken.filter((l) => l.startsWith(kind)).length + 1}`;
}

/** Number newly saved files against the ones already attached, newest last. */
export function labelAttachments(
  saved: SavedAttachment[],
  attached: Attached[],
  previews: Array<string | undefined>,
): Attached[] {
  const taken = attached.map((file) => file.label);
  return saved.map((file, index) => {
    const label = attachmentLabel(file.type, taken);
    taken.push(label);
    return { ...file, label, url: previews[index] };
  });
}

/** The markers `labelAttachments` earned, as they go into the text. */
export const attachmentMarks = (marked: Attached[]): string => marked.map((file) => `[${file.label}]`).join("");

export type ComposerKey = "skill" | "close" | "send" | null;

/**
 * What a keystroke means here, which depends on whether the picker is open.
 *
 * Tab takes the first match while the picker is up and does nothing otherwise;
 * ⌘/Ctrl+Enter always sends. Everything else is ordinary typing.
 */
export function keyAction(
  e: { key: string; metaKey: boolean; ctrlKey: boolean },
  slashOpen: boolean,
  hasMatch: boolean,
): ComposerKey {
  if (slashOpen && (e.key === "Escape" || e.key === "Tab")) return e.key === "Tab" && hasMatch ? "skill" : "close";
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return "send";
  return null;
}

export const toDraft = (text: string, files: Attached[]): Draft => ({
  text: text.trim(),
  attachments: files.map(({ name, path, type, label }) => ({ name, path, type, label })),
});

/** An unmeasured box has no height of its own yet, so CSS keeps it at `rows`. */
export const boxHeight = (h: number): string | undefined => (h ? `${h}px` : undefined);

/** The stamp on a tile with no image preview. */
export const tileBadge = (file: { type: string; name: string }): string =>
  file.type === "inode/directory" ? "DIR" : (file.name.split(".").pop() ?? "file").slice(0, 4).toUpperCase();

/** Files and folders arrive from different APIs; the upload only knows `Picked`. */
export const asPicked = (list: FileList | File[] | Picked[]): Picked[] =>
  [...list].map((f) => (f instanceof File ? { file: f, rel: f.name } : f));

export const pastedName = (n: number, mime: string): string => `pasted-${n}.${mime.split("/")[1] ?? "png"}`;

export const appendLine = (prev: string, line: string): string => (prev ? `${prev}\n${line}` : line);
