import type { DB } from "../../db.ts";

/**
 * Nothing that is a credential reaches an event, a frame or a log.
 *
 * `claude setup-token` prints the token it just minted, and the login streams the
 * CLI's output to the panel so the boss can see the link — so the token went on
 * screen, in full, and on a failure it went into the `event` table with the last
 * 300 characters of output. Migration 035 in db.ts already promised a stored
 * credential reaches no event, prompt or log; it
 * was a promise with nothing enforcing it (硬约束 3).
 *
 * Two passes, in GitHub Actions' order and for its reason. Actions masks by
 * *value* (`::add-mask::`), not by shape, because the runner already knows what
 * the secrets are and a value match cannot be fooled by a format change. So do
 * we: every stored credential is registered here. The patterns are the backstop
 * for the one window where a value pass cannot help — a credential that has been
 * printed but not yet saved, which is exactly the leak that started this.
 *
 * No dependency: pino's redact takes object paths rather than values, and
 * gitleaks / detect-secrets scan repositories rather than filter a stream.
 */

const MASK = "「凭据已抹掉」";

/**
 * Shapes worth catching before they are stored.
 *
 * Long, provider-stamped prefixes only. A short or generic pattern would eat
 * ordinary text — a gate log full of masks teaches the boss to distrust the mask.
 */
const SHAPES: RegExp[] = [
  // Anthropic: sk-ant-oat01- (subscription) and sk-ant-api03- (key).
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // OpenAI, and anything else that copied the prefix.
  /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/g,
  // GitHub, in all five stampings.
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // A JWT, which is what a pasted auth.json is made of.
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // The fields around it, in case the token itself is not a JWT.
  /"(?:access_token|refresh_token|id_token|api_key|secret)"\s*:\s*"[^"]{8,}"/g,
];

/**
 * Values registered for masking. Short ones are refused: a two-character secret
 * would blank half of every sentence, and nothing that short is a credential.
 */
const known = new Set<string>();
const MIN = 12;

/**
 * Register one credential, the way `::add-mask::` does.
 *
 * A pasted auth.json is registered whole and in parts: what the sidecar injects
 * is one token out of that file, so the file never appears but the token does.
 */
export function maskValue(v: string): void {
  const s = v.trim();
  if (s.length >= MIN) known.add(s);
  if (s.startsWith("{")) for (const m of s.matchAll(/"([^"]{16,})"/g)) known.add(m[1]!);
}

/** Register everything already stored. Called at open and after every save. */
export function rememberSecrets(db: DB): void {
  for (const r of db.query<{ secret: string }, []>("SELECT secret FROM runtime_auth").all()) {
    maskValue(r.secret);
  }
}

/** Only for the test: the registry outlives a db in this process. */
export function forgetSecrets(): void {
  known.clear();
}

export function scrub(text: string): string {
  let out = text;
  // ponytail: linear in the number of stored credentials, which is three. A
  // trie only pays off in the thousands.
  for (const v of known) if (out.includes(v)) out = out.split(v).join(MASK);
  for (const re of SHAPES) out = out.replace(re, MASK);
  return out;
}
