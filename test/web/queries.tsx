import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The cache the panel's reads live in, for a test that renders one of them.
 *
 * Not in `test/support/`: that directory is shared with the server suites, and this
 * is a browser-only concern for the files in this directory.
 */
/**
 * A fresh client per mount, deliberately. A module-level client would carry one
 * test's answers into the next — these files render the same component with a
 * different store several times in a row, and a shared cache would let the second
 * render come up already holding the first one's data instead of the reading state
 * it is being asked about.
 *
 * `retry: false` matches `app/main.tsx`: the real panel does not retry either, and
 * a retry here only turns a wrong URL into a slow test.
 */
export function WithQueries({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
