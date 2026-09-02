/**
 * The provider, answering — because a login now asks it before it stores.
 *
 * `finishClaudeLogin` checks the token it read off the terminal against
 * `GET /v1/models` before saving it, so a test that drives a login with a
 * made-up token reaches the real api.anthropic.com and is told 401.
 */
/**
 * Left unstubbed the suite would also answer differently with and without a
 * network: a refused fetch is reported as unverified and lets the token through,
 * so the same test is green offline and red in CI. Only the probe is
 * intercepted; everything else, including the sandbox server a harness stands up
 * on localhost, goes to the real `fetch`.
 */
export function providerAnswers(status = 200): () => void {
  const seen = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/v1/models")) return new Response("{}", { status });
    return await seen(input, init);
  }, seen);
  return () => {
    globalThis.fetch = seen;
  };
}
