import type { z } from "zod";
import { ATTACHMENT_HEADER, type Attachment as AttachmentSchema } from "../../contracts/fields.ts";

export type Attachment = z.infer<typeof AttachmentSchema>;

const IMAGE_TAG = " (image)";

export function withAttachments(text: string, attachments?: Attachment[]): string {
  const files = (attachments ?? []).filter((f) => f?.path);
  if (!files.length) return text;
  return (
    `${text}\n\n${ATTACHMENT_HEADER}\n` +
    files
      .map((f) => `- ${f.label ? `[${f.label}] ` : ""}${f.path}${f.type?.startsWith("image/") ? IMAGE_TAG : ""}`)
      .join("\n")
  );
}

/**
 * The line `withAttachments` writes, read back.
 *
 * Built once: nothing in it varies, so compiling it per call was paying for the
 * same pattern on every prompt assembly. Shared safely because `matchAll` works
 * on its own clone and never moves this one's `lastIndex`.
 */
// fallow-ignore-next-line security-sink -- built once at module load from `IMAGE_TAG` and nothing else, through `RegExp.escape`. Spelling the tag out as a literal here instead would let this pattern drift from the line `withAttachments` writes, which is the reason it is interpolated.
const IMAGE_LINE = new RegExp(`^- (?:\\[[^\\]]+\\] )?(\\S+)${RegExp.escape(IMAGE_TAG)}$`, "gm");

/** The image attachments in an assembled prompt, for CLIs that need them as flags. */
export function imagePaths(prompt: string): string[] {
  return [...prompt.matchAll(IMAGE_LINE)].map((m) => m[1]!);
}
