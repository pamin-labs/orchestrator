import { z } from "zod";

/**
 * What a provider's device login hands the browser while it waits.
 *
 * Its own file because it shares nothing with the panel snapshot beside it: the
 * snapshot is the fleet's state, re-read on every change, and this is a short-lived
 * handshake between clicking 连接 and the CLI coming back.
 */
/**
 * The seam it does cross is real, which is why it stays a contract rather than
 * moving into either side: the server produces the value and the browser validates
 * it, so the schema and the type are two views of one wire format and splitting them
 * would let the two drift with nothing to notice.
 */
export const ClaudeLoginFlowSchema = z.object({ url: z.string(), expiresAt: z.number() });

/** Codex shows a code the boss types into the page the URL opens; Claude does not. */
export const CodexLoginFlowSchema = ClaudeLoginFlowSchema.extend({ code: z.string() });

export type ClaudeLoginFlow = z.infer<typeof ClaudeLoginFlowSchema>;
export type CodexLoginFlow = z.infer<typeof CodexLoginFlowSchema>;
