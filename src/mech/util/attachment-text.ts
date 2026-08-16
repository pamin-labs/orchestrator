import type { z } from "zod";
import type { Attachment as AttachmentSchema } from "../../contracts/fields.ts";

export type Attachment = z.infer<typeof AttachmentSchema>;

const IMAGE_TAG = " (image)";

export function withAttachments(text: string, attachments?: Attachment[]): string {
  const files = (attachments ?? []).filter((f) => f?.path);
  if (!files.length) return text;
  return (
    `${text}\n\n附件（路径如下）：\n` +
    files
      .map((f) => `- ${f.label ? `[${f.label}] ` : ""}${f.path}${f.type?.startsWith("image/") ? IMAGE_TAG : ""}`)
      .join("\n")
  );
}

/** The image attachments in an assembled prompt, for CLIs that need them as flags. */
export function imagePaths(prompt: string): string[] {
  const re = new RegExp(`^- (?:\\[[^\\]]+\\] )?(\\S+)${RegExp.escape(IMAGE_TAG)}$`, "gm");
  return [...prompt.matchAll(re)].map((m) => m[1]!);
}
