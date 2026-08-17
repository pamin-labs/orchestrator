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
 */
export const server = setupServer();

/**
 * Arm interception for the calling test file: `mockHttp()` at its top level.
 *
 * The lifecycle inside is the documented one for `setupServer`
 * (https://mswjs.io/docs/api/setup-server): `listen` once, `resetHandlers`
 * between tests so a `server.use()` cannot leak into the next one, `close` at the
 * end. What is *not* documented is why it is a function here rather than three
 * hooks at module scope, which is how MSW's own setup file is written.
 *
 * Two reasons, and both are Bun's:
 *
 * A hook registers against whichever file is being loaded when the call runs. A
 * module is evaluated once per process, so module-scope hooks in a shared file
 * would attach to whichever test file imported it first and silently do nothing
 * for the second — the kind of failure that reads as "MSW does not work here".
 *
 * And this cannot live in `test/support/setup.ts` with the other global setup,
 * because a preload applies to every file: interception is process-wide once
 * started, and `test/integration` boots a real server on localhost and talks to
 * it. Arming it per file is what keeps `onUnhandledRequest: "error"` absolute
 * where it is on, instead of drilling an exemption through it.
 */
export function mockHttp(): void {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });
}
