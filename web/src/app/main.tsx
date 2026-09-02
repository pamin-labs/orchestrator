import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app";
import { startTheme } from "../ui/theme";
import { I18nProvider } from "@lingui/react";
import { i18n, startLocale } from "../i18n";

// Before the first paint: React mounting in the wrong theme and correcting
// itself is a flash of the other one on every load.
startTheme();
// Same reason, one language over: the panel coming up in Chinese and correcting
// itself once `/state` lands is a flash of the other one on every load. Awaited
// because the catalog is a chunk now — rendering before it arrives is that
// flash, just from a different direction.
await startLocale();

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

/**
 * Kept and named, where it used to be thrown away.
 *
 * A mounted React tree is the largest process-global there is. Radix puts its
 * focus scopes' `focusin`/`focusout` handlers on `document`, and clearing
 * `body.innerHTML` takes the nodes away and leaves the handlers — so a tree with
 * no handle cannot be taken down at all.
 */
/**
 * `bundle-boots` loads this file into a document it shares with every other
 * browser test in its worker. With nothing to unmount, its focus scope stayed
 * behind and fought the next test's over where focus belongs: `RangeError:
 * Maximum call stack size exceeded`, in a file that had not gone near the
 * bundle. The browser pays nothing for the export — the page loads this as
 * `<script type="module">`.
 */
export const root = createRoot(document.getElementById("root")!);

root.render(
  <QueryClientProvider client={queries}>
    <I18nProvider i18n={i18n}>
      <App />
    </I18nProvider>
  </QueryClientProvider>,
);
