import { execSync } from "child_process";
import { mkdirSync } from "fs";

try {
  mkdirSync("web/dist", { recursive: true });
  execSync("bun run build:web", { stdio: "inherit" });
} catch (e) {
  console.error("Build failed:", e);
  process.exit(1);
}
