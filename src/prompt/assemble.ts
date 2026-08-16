/**
 * The ONLY place a turn's input is assembled. See docs/project/plan.md §7 token economics #1.
 *
 * The rule: everything that varies per turn goes in `prompt` (a fresh user
 * message, appended at the end). Everything else is `stable` and must be
 * byte-identical for the whole life of a session.
 *
 * Getting this wrong does not break anything visibly — the agent still works,
 * the tests still pass, and every turn silently re-reads the entire prompt at
 * full price instead of 0.1x. That is why the invariant lives in one function
 * with a hash, and why `test/cache-position.test.ts` guards it.
 *
 * Corollary that is easy to miss: when the stable half legitimately changes
 * (lessons list updated, role prompt edited, model re-tiered), we must ROTATE
 * the session rather than mutate it. `needsRotation()` decides.
 */

/** The half that must never change within a session. */
export interface StablePrompt {
  /** Appended to the default system prompt. Role + onboarding + lessons. */
  systemAppend: string;
  model: string;
  /**
   * Reasoning effort, already clamped to what this role's provider accepts.
   * Hashed with the rest: raising it changes how the model reasons over the same
   * prefix, so the session rotates rather than resuming under a new setting.
   */
  effort?: string;
  /**
   * Built-in tools whose *definitions* are loaded. Distinct from allowedTools,
   * which only gates permission — a tool left in the built-in set costs prompt
   * prefix on every turn whether or not the agent may call it.
   */
  tools: string[];
  allowedTools: string[];
  addDirs: string[];
  /** sha256 of everything above. Stored on the session; compared each turn. */
  hash: string;
}

/** The half that is different every turn. Always lands at the very end. */
export interface Delta {
  /** The slice/task card the agent is working. */
  card?: string;
  /** Unread channel digest (already capped/summarised by the Librarian). */
  unread?: string;
  /** Result of a lease this agent was waiting on. */
  leaseResult?: string;
  /** The boss (or a stand-in from the answer chain) said something. */
  bossSay?: string;
  /** Rejection feedback: gate failure lines + reviewer's specific complaints. */
  rejection?: string;
  /** Handoff note from the retired session this one replaces. */
  handoff?: string;
  /**
   * Skill text the boss pointed at, read off the host and inlined for this turn only.
   * Never part of the stable half: a skill used once must not tax every turn.
   */
  skills?: string;
  /** Anything else, verbatim, last. */
  extra?: string;
}

export interface TurnInput {
  stable: StablePrompt;
  /** Passed to `claude -p <prompt>`; becomes the newest user message. */
  prompt: string;
}

export interface StableParts {
  /** Role prompt from roles/<role>.yaml. */
  rolePrompt: string;
  /** Project onboarding pack — note(kind=onboarding). */
  onboarding?: string;
  /** Lessons distilled from retros — note(kind=lesson), capped at 20. */
  lessons?: string[];
  /** Language for human-facing output. Code/commits stay English. */
  language?: string;
  model: string;
  effort?: string;
  tools?: string[];
  allowedTools: string[];
  addDirs: string[];
}

const ORCH_CONTRACT = `## Talking to the orchestrator

Use Bash. Every command blocks and returns its result on stdout.

  orch ctx query "<question>"          # ALWAYS FIRST, before grep/git/reading files.
      # One call answers: every slice in this group with status and acceptance line;
      # the group's status, branch and PR; the last result of each gate; the questions
      # still unanswered; and where a thing lives — a summary tree of the repo that a
      # model walks, so it lands on the right file even when the file name shares no
      # word with your question. Looking it up yourself is the expensive path: every
      # tool round re-reads this whole conversation.
  orch ask-boss --brief "<=20 chars: what it is about" --kind env|spec|boundary|design|other \
      --severity blocker|advisory "<question>"
      # --brief is the one line the boss's queue shows. Without it the queue prints
      # the first sentence of a question written for another agent.
      # --kind groups them: one bad premise strands every slice behind it, and the
      # queue folds a dozen questions of the same kind into one card instead of a
      # dozen decisions on a page where there is one. env = the box is wrong
      # (missing dependency, no network, a path the sandbox refuses); spec = the
      # acceptance line cannot be verified as written; boundary = another group
      # owns the file; design = a judgement call about how it should work.
  orch lease <resource> [--arg k=v]    # run a rate-limited resource, get the digest
  orch lease log <id> [--grep RE]      # full log, stays out of your context
  orch mail <target> --intent ask|request|inform|note|decision "<body>"
  orch journal add --kind decision|journal|retro|risk -   # body on stdin, max 6 lines
  orch task list                       # id + status + title, one per line
  orch task claim <id>
  orch task done <id> --claim '{"files":["a.ts"],"summary":"…"}'
  orch task done <id> --already-done "S1 already covered this"   # nothing left to change
      # the task that FINISHES a slice also needs --review "<verdict per acceptance
      # criterion + the diff line that satisfies it>". Refused if it says nothing.
  orch task split <group_id> -   # the boss put several unrelated asks in one box:
                                 # JSON array on stdin, one requirement each. Each
                                 # gets its own card, branch and PR. Before the card.
  orch draft <group_id> -                                 # DRAFT card on stdin (Dispatcher/PM)
  orch owns <group_id> --path <glob> …                    # Architect cuts a boundary
  orch drop <group_id> --why "…" --duplicate <group>      # this is already covered:
  orch drop <group_id> --why "…" --commit <sha>           # propose dropping it. The
      # evidence is checked here, and the boss confirms. Say it BEFORE writing a card
      # for work that does not need doing — a duplicate requirement, or one somebody
      # fixed between the boss typing it and you reading the code.
  orch review <slice_id> --verdict pass|fail --note "…"   # QA files its verdict
  orch audit <group_id> --verdict pass|fail --note "…"    # Auditor files its verdict
  orch answer <esc_id> --answer "…" [--ref <note_id>]     # answer a question routed to you
  orch answer <esc_id> --abstain --why "…"                # pass it up instead of guessing
  orch status "<one line>"             # what you are doing, for the desk wall

Git is plain \`git\`, in your own checkout. There is no \`orch git\`, and no
credential here can write to the remote — the orchestrator takes the branch out of
this sandbox and pushes it, so do not look for a way to push.

Do not read whole files when \`orch ctx query\` can point you at the lines.

A criterion about what the page does ("the menu opens", "the row is clickable") is
checkable and reading the JSX is not the check: write the steps to a JSON file and
\`orch lease browser --arg steps=qa-steps.json\`. It boots this checkout on a random
port against a throwaway database, so \`api\` steps seed whatever state you need, and
a failing step screenshots itself. Steps are data, never a command — that is what
keeps \`orch\` a fixed set of actions rather than a shell.

Put \`orch\` first in the command when piping into it — \`orch journal add --kind
decision <<'EOF'\` is permitted, \`cat file | orch journal add\` is not, because the
permission check reads the start of the line.

Printing something as your reply does NOT record it. Anything that has to persist
— a card, a verdict, a journal entry, an answer — happens through one of these
commands or it did not happen.`;

/**
 * Build the stable half. Order is fixed and content is trimmed so the same
 * inputs always hash the same — an accidental reorder would look like a
 * legitimate change and force a pointless session rotation.
 */
export function buildStable(parts: StableParts): StablePrompt {
  const sections: string[] = [parts.rolePrompt.trim()];

  if (parts.language) {
    sections.push(
      `## Output language\n\nHuman-facing text (journal, channel messages, questions to the boss, ` +
        `summaries): ${parts.language}.\nCode, commit messages, branch names, PR title and body, ` +
        `error strings: English.`,
    );
  }
  sections.push(ORCH_CONTRACT);
  if (parts.onboarding?.trim()) {
    sections.push(`## Project onboarding\n\n${parts.onboarding.trim()}`);
  }
  if (parts.lessons?.length) {
    const items = parts.lessons.map((l) => `- ${l.trim()}`).join("\n");
    sections.push(`## Lessons from previous groups\n\n${items}`);
  }

  const systemAppend = sections.join("\n\n");
  const stable: Omit<StablePrompt, "hash"> = {
    systemAppend,
    model: parts.model,
    ...(parts.effort ? { effort: parts.effort } : {}),
    tools: [...(parts.tools ?? toolsFromAllowed(parts.allowedTools))],
    allowedTools: [...parts.allowedTools],
    addDirs: [...parts.addDirs],
  };
  return { ...stable, hash: hashStable(stable) };
}

function hashStable(s: Omit<StablePrompt, "hash">): string {
  const h = new Bun.CryptoHasher("sha256");
  // Field order is part of the contract; do not sort or reformat. The separator
  // is escaped rather than a raw NUL byte so the source survives tooling.
  const SEP = "\u0000";
  h.update(s.systemAppend);
  h.update(SEP);
  h.update(s.model);
  h.update(SEP);
  h.update(s.effort ?? "");
  h.update(SEP);
  // The loaded tool set is part of the cached prefix, so changing it has to
  // rotate the session exactly like a changed role prompt does.
  h.update(s.tools.join(","));
  h.update(SEP);
  h.update(s.allowedTools.join(","));
  h.update(SEP);
  h.update(s.addDirs.join(","));
  return h.digest("hex");
}

/**
 * The built-in tools implied by a permission whitelist: `Bash(orch *)` needs
 * `Bash` loaded, `Read` needs `Read`. Everything else stays out of the prefix.
 */
function toolsFromAllowed(allowed: string[]): string[] {
  const set = new Set<string>();
  for (const a of allowed) {
    const name = a.includes("(") ? a.slice(0, a.indexOf("(")) : a;
    if (name.trim()) set.add(name.trim());
  }
  // `Skill`, for every role, not per role yaml. Measured: `--tools` without it
  // loads no skill catalogue at all — asked to list its skills the model answers
  // NONE — so the mount, the tick boxes and the settings page were all decoration.
  // It is not a permission (that is `allowedTools`, and the container is the
  // boundary anyway); it is the one entry that makes a staged skill reachable.
  set.add("Skill");
  return [...set];
}

/** Fixed section order, newest information last. Empty parts are omitted. */
const DELTA_ORDER: Array<[keyof Delta, string]> = [
  ["handoff", "Handoff from your previous session"],
  ["card", "Your current work"],
  ["rejection", "This was sent back — fix these"],
  ["leaseResult", "Lease result"],
  ["unread", "Channel updates since your last turn"],
  ["skills", "Follow this skill for this work"],
  ["bossSay", "From the boss"],
  ["extra", ""],
];

export function buildDelta(delta: Delta): string {
  const out: string[] = [];
  for (const [key, heading] of DELTA_ORDER) {
    const v = delta[key];
    if (!v?.trim()) continue;
    out.push(heading ? `## ${heading}\n\n${v.trim()}` : v.trim());
  }
  return out.join("\n\n");
}

/**
 * Assemble a turn. The delta is the prompt and nothing else — it is never
 * merged into `systemAppend`, which is the whole point of this module.
 */
export function assemble(stable: StablePrompt, delta: Delta): TurnInput {
  return { stable, prompt: buildDelta(delta) };
}

/**
 * True when the stable half changed and the session must be replaced rather
 * than continued. Mutating the stable half in place would invalidate the
 * cached prefix on every subsequent turn.
 */
export function needsRotation(sessionStableHash: string | null, next: StablePrompt): boolean {
  return sessionStableHash !== null && sessionStableHash !== next.hash;
}
