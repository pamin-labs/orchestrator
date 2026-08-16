/**
 * Work out a project's gates from what the repository root looks like.
 *
 * A project with no gates fails every slice by design, so leaving this to the
 * boss means the first thing the system does on a new project is refuse to work
 * and look broken. Detection is best-effort and always visible: whatever it
 * guesses is written into project config, where it can be corrected.
 *
 * No filesystem in here. The repository this reads is a clone inside a group's
 * container (007 §2) — there is no host checkout to point at any more — so the
 * caller gathers a listing and a few files however it can reach them, and this
 * stays a pure function of that. The fixture tests are the reason: they are the
 * only thing covering these rules, and they now need neither a temp directory
 * nor a container.
 */

/** A repository root: what is in it, and the contents of the few files that matter. */
import { jsonOr } from "../../contracts/json.ts";
import { z } from "zod";

export interface Root {
  /** Names directly in the root, `ls -A`. */
  names: string[];
  read: (name: string) => string | null;
}

/**
 * The only files any rule opens. Everything else is decided by a name existing,
 * so the caller fetches these and nothing else.
 */
export const READS = ["package.json", "Makefile", "makefile", "GNUmakefile"];

export interface DetectedGate {
  name: string;
  /** Tokenised, never shell-parsed — same rule as every other resource. */
  template: string;
  errorRegex: string;
}

interface Rule {
  marker: (repo: Root) => boolean;
  gates: (repo: Root) => DetectedGate[];
  /**
   * How to bring a fresh checkout's dependencies up, or null when the stack needs
   * nothing before its gates run. A default the bootstrap role can skip past — an agent
   * cannot do it, the sandbox denies writes outside its own paths.
   */
  install?: (repo: Root) => string | null;
}

const PackageJsonSchema = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
  workspaces: z.union([z.array(z.string()), z.object({ packages: z.array(z.string()) })]).optional(),
});
type PackageJson = z.infer<typeof PackageJsonSchema>;

const readJson = (repo: Root, name: string): PackageJson | null =>
  jsonOr(repo.read(name), PackageJsonSchema.nullable(), null);

const hasFile = (repo: Root, name: string) => repo.names.includes(name);

const globExists = (repo: Root, re: RegExp) => repo.names.some((f) => re.test(f));

/** Rule order matters: the first marker that matches wins. */
const RULES: Rule[] = [
  {
    marker: (repo) => hasFile(repo, "package.json"),
    // Only where a lockfile names the manager outright. Anything less certain is
    // the bootstrap role's job — it reads the README, the CI workflow and the
    // Makefile, which is how you tell poetry from pdm from a plain venv without
    // a table in here that is wrong for somebody.
    install: (repo) =>
      hasFile(repo, "bun.lock") || hasFile(repo, "bun.lockb")
        ? "bun install --frozen-lockfile"
        : hasFile(repo, "package-lock.json")
          ? "npm ci"
          : hasFile(repo, "pnpm-lock.yaml")
            ? "pnpm install --frozen-lockfile"
            : hasFile(repo, "yarn.lock")
              ? "yarn install --frozen-lockfile"
              : null,
    gates: (repo) => {
      const pkg = readJson(repo, "package.json") ?? {};
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
          // The local binary, not `bunx`/`npx`. Those re-resolve and install on
          // every call, and every worktree shares one node_modules by symlink —
          // two gates at once raced on it and one came back `Failed to link
          // jiti: EEXIST`, which the group read as its own build being broken.
          template: "node_modules/.bin/tsc --noEmit",
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
    // cargo fetches on build; nothing to do up front.
    install: () => null,
    gates: () => [
      { name: "test", template: "cargo test --quiet", errorRegex: "^(error|test result: FAILED)" },
      { name: "lint", template: "cargo clippy --quiet -- -D warnings", errorRegex: "^(error|warning)" },
    ],
  },
  {
    marker: (repo) => hasFile(repo, "go.mod"),
    install: () => "go mod download",
    gates: () => [
      { name: "test", template: "go test ./...", errorRegex: "^(--- FAIL|FAIL|.*\\.go:)" },
      { name: "vet", template: "go vet ./...", errorRegex: "\\.go:" },
    ],
  },
  {
    marker: (repo) => hasFile(repo, "pyproject.toml") || hasFile(repo, "setup.cfg"),
    // uv.lock is unambiguous. `pyproject.toml` alone is not — poetry, pdm, hatch,
    // rye and a plain venv all use it — so that one goes to the bootstrap role.
    install: (repo) => (hasFile(repo, "uv.lock") ? "uv sync" : null),
    gates: () => [{ name: "test", template: "pytest -q", errorRegex: "^(E |FAILED|ERROR)" }],
  },
  {
    marker: (repo) => globExists(repo, /\.(sln|csproj)$/),
    install: () => "dotnet restore",
    gates: () => [{ name: "test", template: "dotnet test --nologo", errorRegex: "(error|Failed!|\\s+Failed )" }],
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

function hasMakeTarget(repo: Root, target: string): boolean {
  for (const f of ["Makefile", "makefile", "GNUmakefile"]) {
    const body = repo.read(f);
    if (body === null) continue;
    return new RegExp(`^${target}\\s*:`, "m").test(body);
  }
  return false;
}

/** The install command for whichever stack this repo is, or null. */
export function detectInstall(repo: Root): string | null {
  for (const r of RULES) if (r.marker(repo)) return r.install?.(repo) ?? null;
  return null;
}

export function detectGates(repo: Root): DetectedGate[] {
  for (const rule of RULES) {
    if (!rule.marker(repo)) continue;
    const gates = rule.gates(repo);
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
export function detectShared(repo: Root): string[] {
  const out: string[] = [];
  if (readJson(repo, "package.json")?.workspaces) out.push("packages/*/package.json");
  for (const f of ["pnpm-workspace.yaml", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock"]) {
    if (hasFile(repo, f)) out.push(f);
  }
  return out;
}
