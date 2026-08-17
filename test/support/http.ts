import { afterAll, afterEach, beforeAll } from "bun:test";
import { setupServer } from "msw/node";

/**
 * The network, answered from handlers, with no `fetch` replaced.
 *
 * A hand-stubbed `fetch` is a fake of the wrong thing. `src/mech/git/github.ts`
 * hands its fetch to `@octokit/core` and lets the retry and throttling plugins
 * own the loop, the backoff, the `doNotRetry` list and the secondary-rate-limit
 * decision — so a test that substitutes `fetch` wholesale is testing the stub's
 * idea of those, and every one of them is a path worth a test. MSW intercepts
 * one layer lower (`@mswjs/interceptors`), so the request travels the real
 * Octokit path and the real `fetch`, and only the answer is ours.
 *
 * `onUnhandledRequest: "error"` is the point rather than a detail: a request
 * nobody wrote a handler for fails the test instead of reaching github.com. In
 * an open-source repository that is the difference between a suite that is
 * offline by construction and one that is offline by everybody remembering.
 * There is no setting to relax here — a test that wants the network wants a
 * handler.
 *
 * The lifecycle is the documented one for `setupServer`
 * (https://mswjs.io/docs/api/setup-server): `listen` once, `resetHandlers`
 * between tests so a `server.use()` cannot leak into the next one, `close` at
 * the end. Registered here at module scope, so importing this file is the whole
 * setup — and deliberately *not* in `test/support/setup.ts`, which is preloaded
 * into every file: interception is global once started, and the suite has
 * integration tests that talk to a real localhost server of their own.
 */
export const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});
