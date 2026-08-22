import { generateMessageId } from "@lingui/message-utils/generateMessageId";
import type { Said } from "../../src/contracts/said.ts";

/**
 * The descriptor a `msg` template expands to, for a file the macro does not run
 * on.
 *
 * `test/` is deliberately outside the macro's filter — the product is what gets
 * expanded — so a test that needs a real descriptor builds one here. The id is
 * Lingui's own hash of the English, which is the only way to name a message
 * without writing a hash down: a hash in a source file is a number nobody can
 * check and nothing updates when the sentence is reworded.
 */
/**
 * The return type is left inferred rather than widened to `Said`: a fixture also
 * has to fit `meta`, which is JSON, and `Said["values"]` is Lingui's own
 * `Record<string, unknown>`. `String(...)` because `@lingui/message-utils` types
 * `generateMessageId` as returning `any`.
 */
export const said = (message: string, values?: Record<string, string | number>) => ({
  id: String(generateMessageId(message)),
  message,
  ...(values ? { values } : {}),
});

/** Stated once, so the inferred shape above cannot drift from the contract. */
const _fits: Said = said("x");
void _fits;
