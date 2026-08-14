import { createRoot } from "react-dom/client";
import { App } from "./app";
import { startTheme } from "./ui/theme";

// Before the first paint: React mounting in the wrong theme and correcting
// itself is a flash of the other one on every load.
startTheme();

createRoot(document.getElementById("root")!).render(<App />);
