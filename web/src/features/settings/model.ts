import { z } from "zod";

/**
 * Which pane of the settings dialog is open, as a value the URL can carry.
 *
 * It lived at the top of `view.tsx` and `navigation/model.ts` imported it from there
 * — so `parseSelection()`, whose whole job is to turn a hash into a `Selection`,
 * dragged in a 700-line React component and the Radix primitives behind it. A hash
 * parser is the one part of navigation that should be callable without a document.
 */
/**
 * The enum is the contract between the hash and the dialog, so it belongs to
 * neither: it sits beside the model, which is where the schema for a stored value
 * goes, and both the view and the navigation model read it from here.
 */
export const SectionSchema = z.enum([
  "cred",
  "github",
  "host",
  "server",
  "timing",
  "skills",
  "sched",
  "models",
  "turn",
  "prefs",
  "gates",
  "sandbox",
  "remove",
]);
export type Section = z.infer<typeof SectionSchema>;
