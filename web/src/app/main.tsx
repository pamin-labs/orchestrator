import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app";
import { startTheme } from "../ui/theme";
import "../i18n";

// Before the first paint: React mounting in the wrong theme and correcting
// itself is a flash of the other one on every load.
startTheme();

/**
 * One cache for every read this panel does.
 *
 * Two defaults are wrong for a panel on loopback. `retry: 3` with a backoff hides a
 * dead server behind ten seconds of nothing — `readApi()` already puts the server's
 * own refusal on screen, and a second attempt at 127.0.0.1 tells nobody anything.
 *
 * `staleTime: 0` stays deliberately: everything here is somebody else's state, and
 * this page is never the one that changed it.
 */
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queries}>
    <App />
  </QueryClientProvider>,
);
