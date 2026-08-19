import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { http, type RequestHandler } from "msw";
import { setupServer } from "msw/node";

/**
 * The network, answered from handlers, with no `fetch` replaced.
 *
 * A hand-stubbed `fetch` fakes the wrong thing. `github.ts` hands its fetch to
 * `@octokit/core` and lets the retry and throttling plugins own the loop, the
 * backoff, the `doNotRetry` list and the secondary-rate-limit decision — so a test
 * that substitutes `fetch` wholesale is testing the stub's idea of those. MSW
 * intercepts one layer lower, so the request travels the real path and only the
 * answer is ours.
 */
/**
 * `onUnhandledRequest: "error"` is the point rather than a detail: a request
 * nobody wrote a handler for fails the test instead of reaching github.com. In an
 * open-source repository that is the difference between a suite offline by
 * construction and one offline by everybody remembering. There is nothing to relax
 * — a test that wants the network wants a handler.
 */
export const server = setupServer();

/**
 * Arm interception for the calling test file: `mockHttp()` at its top level.
 *
 * Handlers passed here stand for every test in the file and are re-registered
 * after each reset; a `server.use()` inside a test is prepended, so it wins. The
 * lifecycle is `setupServer`'s documented one — listen once, reset between tests,
 * close at the end (https://mswjs.io/docs/api/setup-server).
 */
/**
 * A function rather than three hooks at module scope, which is how MSW's own
 * setup file is written. Both reasons are Bun's.
 *
 * A hook registers against whichever file is loading when the call runs, and a
 * module is evaluated once per process — module-scope hooks in a shared file
 * would attach to whichever test imported it first and silently do nothing for
 * the second, which reads as "MSW does not work here".
 */
/**
 * And it cannot live in `setup.ts` with the other global setup, because a preload
 * applies to every file: interception is process-wide once started, and
 * `test/integration` boots a real server and talks to it. Arming per file is what
 * keeps `onUnhandledRequest: "error"` absolute where it is on.
 */
export function mockHttp(...standing: RequestHandler[]): void {
  beforeAll(() => {
    // `"error"`, not a custom callback. The string strategy prints a nine-line
    // block and rejects the request; the block is noise, and a callback that
    // throws instead looks like the tidy version of the same guarantee.
    //
    // It is not. MSW invokes a callback as `strategy(request, { warning, error })`
    // and ignores what it returns — measured against 2.15: a throw there does not
    // stop the request, and the fetch *resolves*, which means it left the machine.
    // Trading a printed block for a suite that can silently reach the network is
    // the wrong trade, so the block stays.
    server.listen({ onUnhandledRequest: "error" });
  });
  if (standing.length > 0) {
    beforeEach(() => {
      server.use(...standing);
    });
  }
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });
}

/**
 * Every request the file did not answer, left in flight.
 *
 * Half the panel's panes fetch on mount, and a request that never comes back is
 * their first-paint state — the one a loading test is looking at. Passed to
 * `mockHttp()` it is the file saying so out loud, which is the one thing that
 * relaxes `onUnhandledRequest: "error"` and is therefore per file rather than
 * global. A pane whose landed data the test cares about names its own URL, and
 * that handler wins over this one.
 */
export const inFlight = (): RequestHandler => http.all("*", () => new Promise<never>(() => {}));
