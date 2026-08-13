import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Work out a project's gates from what is on disk.
 *
 * A project with no gates fails every slice by design, so leaving this to the
 * boss means the first thing the system does on a new project is refuse to work
 * and look broken. Detection is best-effort and always visible: whatever it
 * guesses is written into project config, where it can be corrected.
 */

export interface DetectedGate {
  name: string;
  /** Tokenised, never shell-parsed — same rule as every other resource. */
  template: string;
  errorRegex: string;
}

interface Rule {
  marker: (repo: string) => boolean;
  gates: (repo: string) => DetectedGate[];
}

const readJson = (p: string): any => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

const hasFile = (repo: string, name: string) => existsSync(join(repo, name));

const globExists = (repo: string, re: RegExp) => {
  try {
    return readdirSync(repo).some((f) => re.test(f));
  } catch {
    return false;
  }
};

/** Rule order matters: the first marker that matches wins. */
const RULES: Rule[] = [
  {
    marker: (repo) => hasFile(repo, "package.json"),
    gates: (repo) => {
      const pkg = readJson(join(repo, "package.json")) ?? {};
      const scripts: Record<string, string> = pkg.scripts ?? {};
      // Prefer bun when the repo already commits a bun lockfile; the runner is
      // whatever the project actually uses, not whatever we like.
      const runner = hasFile(repo, "bun.lock") || hasFile(repo, "bun.lockb") ? "bun" : "npm";
      const out: DetectedGate[] = [];
      // First, and before the tests: a suite that serves a built bundle otherwise
      // tests whichever bundle happened to be lying there. In a worktree that was
      // the main checkout's, so a group's own UI change was invisible to its own
      // gate — and on the boss's machine a deleted button survived a rebuild.
      if (scripts["build:web"]) {
        out.push({
          name: "build",
          template: runner === "bun" ? "bun run build:web" : "npm run build:web",
          errorRegex: "(error|ERROR|failed)",
        });
      }
      if (scripts.test) {
        out.push({
          name: "test",
          template: runner === "bun" ? "bun test" : "npm test",
          errorRegex: "^(error|FAIL|✗|\\s+at )",
        });
      }
      if (scripts.typecheck || scripts.tsc || hasFile(repo, "tsconfig.json")) {
        out.push({
          name: "typecheck",
          template: runner === "bun" ? "bunx tsc --noEmit" : "npx tsc --noEmit",
          errorRegex: "error TS",
        });
      }
      if (scripts.lint) {
        out.push({
          name: "lint",
          template: runner === "bun" ? "bun run lint" : "npm run lint",
          errorRegex: "(error|warning)",
        });
      }
      return out;
    },
  },
  {
    marker: (repo) => hasFile(repo, "Cargo.toml"),
    gates: () => [
      { name: "test", template: "cargo test --quiet", errorRegex: "^(error|test result: FAILED)" },
      { name: "lint", template: "cargo clippy --quiet -- -D warnings", errorRegex: "^(error|warning)" },
    ],
  },
  {
    marker: (repo) => hasFile(repo, "go.mod"),
    gates: () => [
      { name: "test", template: "go test ./...", errorRegex: "^(--- FAIL|FAIL|.*\\.go:)" },
      { name: "vet", template: "go vet ./...", errorRegex: "\\.go:" },
    ],
  },
  {
    marker: (repo) => hasFile(repo, "pyproject.toml") || hasFile(repo, "setup.cfg"),
    gates: () => [{ name: "test", template: "pytest -q", errorRegex: "^(E |FAILED|ERROR)" }],
  },
  {
    marker: (repo) => globExists(repo, /\.(sln|csproj)$/),
    gates: () => [
      { name: "test", template: "dotnet test --nologo", errorRegex: "(error|Failed!|\\s+Failed )" },
    ],
  },
  {
    marker: (repo) => hasFile(repo, "justfile") || hasFile(repo, "Justfile"),
    gates: () => [{ name: "test", template: "just test", errorRegex: "(error|FAIL)" }],
  },
  {
    marker: (repo) => hasMakeTarget(repo, "test"),
    gates: () => [{ name: "test", template: "make test", errorRegex: "(error|FAIL|Error)" }],
  },
];

function hasMakeTarget(repo: string, target: string): boolean {
  for (const f of ["Makefile", "makefile", "GNUmakefile"]) {
    const p = join(repo, f);
    if (!existsSync(p)) continue;
    try {
      return new RegExp(`^${target}\\s*:`, "m").test(readFileSync(p, "utf8"));
    } catch {
      return false;
    }
  }
  return false;
}

export function detectGates(repoPath: string): DetectedGate[] {
  for (const rule of RULES) {
    if (!rule.marker(repoPath)) continue;
    const gates = rule.gates(repoPath);
    if (gates.length) return gates;
  }
  return [];
}

/**
 * Paths that are shared in this particular project, on top of the defaults.
 *
 * A monorepo's workspace root is shared even though nothing about its name says
 * so, and letting one group own it would let that group break every other.
 */
export function detectShared(repoPath: string): string[] {
  const out: string[] = [];
  const pkg = readJson(join(repoPath, "package.json"));
  if (pkg?.workspaces) out.push("packages/*/package.json");
  for (const f of ["pnpm-workspace.yaml", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock"]) {
    if (hasFile(repoPath, f)) out.push(f);
  }
  return out;
}
