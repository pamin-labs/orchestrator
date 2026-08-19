import { z } from "zod";

/** Runtime schemas shared by the agent CLI and the Orch protocol handlers. */
export const MailIntent = z.enum(["ask", "request", "inform", "note", "decision"], {
  error: "intent must be one of: ask, request, inform, note, decision",
});

export const SplitRequirements = z.array(
  z.object({ name: z.string().max(80).optional(), idea: z.string().min(1).max(8000) }),
);

export const ChangedFilesClaimSchema = z.object({
  files: z.array(z.string().trim().min(1)).min(1),
  summary: z.string().trim().min(1).max(4000),
});
