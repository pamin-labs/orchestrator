import { z } from "zod";

/**
 * One note as the panel reads it, which is not one note as the table stores it.
 *
 * `frontmatter` is the stored JSON string rather than a parsed object, and
 * `group` is the group's name joined in — the panel lists notes across groups
 * and an id would make every row a second query. Both are why this is its own
 * shape rather than the `note` row.
 *
 * Separated from the snapshot contract beside it because it shares nothing with
 * it: notes are fetched by their own route with their own filters, and the
 * snapshot never carries them. They sat in one file because both are things the
 * panel receives, which is a description of the transport rather than of either
 * contract.
 */
const PanelNoteSchema = z.object({
  id: z.number(),
  grpId: z.number().nullable(),
  kind: z.string(),
  body: z.string(),
  at: z.number(),
  exportPath: z.string().nullable(),
  frontmatter: z.string().nullable(),
  group: z.string().nullable(),
});

export const NotesResponseSchema = z.object({ notes: z.array(PanelNoteSchema) });

export type PanelNote = z.infer<typeof PanelNoteSchema>;
