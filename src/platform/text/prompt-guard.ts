import { createPromptPurify, type Sink } from "promptpurify";

/**
 * Does this text try to impersonate an instruction? Not: must a human rule on it.
 *
 * `isReserved()` in `src/mech/flow/chain.ts` owns the second question, and the two
 * must stay distinct (docs/adr/042). A string can trip both; that is two correct
 * answers, not two owners. This must never influence escalation routing — the
 * moment its verdict decides who answers, it is a second owner of that gate.
 */

/**
 * No `classifier`, because its scores do not separate anything here.
 *
 * Measured on this repository, not reasoned about (docs/adr/042): promptpurify's
 * L5a scores this repo's own benign content at a median of 0.545, while six of
 * eight real injections written against *this* orchestrator score 0.25-0.40. The
 * attacks rank BELOW ordinary source code, so no threshold separates them, and
 * `flagged` would refuse 5 of the 10 files in `roles/` at startup.
 */
/**
 * `inspect()` below is the second reason, and unlike this one it is not a choice:
 * the synchronous entry point does not run a classifier even if a later edit
 * passes one — only `inspectAsync()` does. `onnxruntime-node` is not a dependency
 * of this project; the L5b-L5e models it loads are a separate 14MB download.
 */
const purify = createPromptPurify({ profile: "balanced" });

export interface Hijack {
  /** Tripwire id, e.g. "instruction-override", "role-spoof". */
  rule: string;
  message: string;
  /** The text that fired it, so a human knows which line to delete. */
  excerpt: string;
}

/**
 * The offending span, or null. The gate is `verdict === "blocked"` and nothing
 * else — never a score, never `flagged`. That is the deterministic L1/L2/L4 layer
 * alone, and all 10 shipped roles pass it, which
 * `test/platform/prompt-guard.test.ts` pins.
 *
 * Synchronous because it is cheap: `inspect()` is pure and 55ms at 200KB, against
 * a 20-minute `turnTimeoutMs`, so no call site has to decide whether it can afford
 * this.
 */
export function findHijack(text: string, sink: Sink): Hijack | null {
  const report = purify.inspect(text, { sink });
  if (report.verdict !== "blocked") return null;
  // A block is always a high-severity structural rule; the fallback keeps this
  // total rather than returning null on a shape the library changes later.
  const risk = report.risks.find((r) => r.severity === "high") ?? report.risks[0];
  if (!risk) return null;
  return {
    rule: risk.rule,
    message: risk.message,
    excerpt: risk.span ? report.text.slice(risk.span[0], risk.span[1]).slice(0, 200) : "",
  };
}

/** Stable code: a role's own prompt carries text impersonating an instruction. */
export const ROLE_PROMPT_HIJACK = "ORCH_ROLE_PROMPT_HIJACK";

/**
 * Fields, not a sentence.
 *
 * The panel shows this as a dismissible notice and renders the file and the
 * offending text separately, so the parts stay parts: a message built by
 * concatenation would have to be parsed apart again at the surface that has to
 * display it. `message` is the console form of the same four fields.
 */
export class RolePromptHijackError extends Error {
  readonly code = ROLE_PROMPT_HIJACK;
  /** `roles/engineer.yaml` — what the boss has to open. */
  readonly file: string;
  readonly hijack: Hijack;
  constructor(file: string, hijack: Hijack) {
    super(
      `${ROLE_PROMPT_HIJACK}: ${file} — ${hijack.message} (${hijack.rule})\n` +
        `  remove this from its prompt: ${JSON.stringify(hijack.excerpt)}`,
    );
    this.name = "RolePromptHijackError";
    this.file = file;
    this.hijack = hijack;
  }
}
