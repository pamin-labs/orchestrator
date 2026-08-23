/**
 * Work out a project's gates from what the repository root looks like.
 *
 * A project with no gates fails every slice by design, so leaving this to the boss
 * means the first thing the system does on a new project is refuse to work and look
 * broken. Detection is best-effort and always visible: whatever it guesses is
 * written into project config, where it can be corrected.
 */
/**
 * No filesystem in here. The repository this reads is a clone inside a group's
 * container — there is no host checkout to point at any more — so the caller
 * gathers a listing and a few files however it can reach them, and this stays a
 * pure function of that. The fixture tests are the reason: they are the only thing
 * covering these rules, and they need neither a temp directory nor a container.
 */

/** A repository root: what is in it, and the contents of the few files that matter. */
import { jsonOr } from "../../contracts/json.ts";
import { parseJsonc } from "./jsonc.ts";
import { z } from "zod";

export interface Root {
  /** Names directly in the root, `ls -A`. */
  names: string[];
  /** Any path under the root, root-relative. */
  read: (name: string) => string | null;
  /**
   * Names directly in one subdirectory. Optional: a caller that cannot list
   * `.github/workflows` — every test fixture here, and any older caller — gets
   * the rules below and no CI fallback, rather than an error.
   */
  list?: (dir: string) => string[];
}

/**
 * The only files any rule opens. Everything else is decided by a name existing,
 * so the caller fetches these and nothing else.
 */
export const READS = [
  "package.json",
  "Makefile",
  "makefile",
  "GNUmakefile",
  // Both locations the spec allows. A path with a slash is fetched by its first
  // segment being in the listing, which is what `start.ts` checks.
  ".devcontainer/devcontainer.json",
  ".devcontainer.json",
  // Task runners, opened rather than counted: a `Taskfile.yml` with no `test`
  // task is not a project that runs `task test`, and the file existing says
  // nothing about which tasks are in it.
  "Taskfile.yml",
  "Taskfile.yaml",
  "mise.toml",
  ".mise.toml",
];

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

function scriptGate(
  present: string | undefined,
  name: string,
  runner: "bun" | "npm",
  command: string,
  errorRegex: string,
): DetectedGate | null {
  if (!present) return null;
  return { name, template: runner === "bun" ? `bun ${command}` : `npm ${command}`, errorRegex };
}

function typecheckGate(repo: Root, scripts: Record<string, string>): DetectedGate | null {
  if (!scripts.typecheck && !scripts.tsc && !hasFile(repo, "tsconfig.json")) return null;
  return { name: "typecheck", template: "node_modules/.bin/tsc --noEmit", errorRegex: "error TS" };
}

function packageGates(repo: Root): DetectedGate[] {
  const scripts: Record<string, string> = readJson(repo, "package.json")?.scripts ?? {};
  const runner = hasFile(repo, "bun.lock") || hasFile(repo, "bun.lockb") ? "bun" : "npm";
  return [
    scriptGate(scripts["build:web"], "build", runner, "run build:web", "(error|ERROR|failed)"),
    scriptGate(scripts.test, "test", runner, "test", "^(error|FAIL|✗|\\s+at )"),
    typecheckGate(repo, scripts),
    scriptGate(scripts.lint, "lint", runner, "run lint", "(error|warning)"),
  ].filter((gate): gate is DetectedGate => gate !== null);
}

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
    gates: packageGates,
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
  // A declared task ranks with the conventions rather than below them: a project
  // that wrote `test` down in its own task runner has said which command that is
  // at least as clearly as a lockfile says which package manager.
  {
    marker: (repo) => taskIn(repo, "Taskfile.yml") || taskIn(repo, "Taskfile.yaml"),
    gates: () => [{ name: "test", template: "task test", errorRegex: "(error|FAIL|failed)" }],
  },
  {
    marker: (repo) => miseTask(repo, "mise.toml") || miseTask(repo, ".mise.toml"),
    // Its own runner, since mise is already in the image for the toolchain.
    gates: () => [{ name: "test", template: "mise run test", errorRegex: "(error|FAIL|failed)" }],
  },
  {
    marker: (repo) => hasMakeTestTarget(repo),
    gates: () => [{ name: "test", template: "make test", errorRegex: "(error|FAIL|Error)" }],
  },
];

/** `test:` at the start of a line. One target is the only one anything asks about. */
const MAKE_TEST_TARGET = /^test\s*:/m;

function hasMakeTestTarget(repo: Root): boolean {
  for (const f of ["Makefile", "makefile", "GNUmakefile"]) {
    const body = repo.read(f);
    if (body === null) continue;
    return MAKE_TEST_TARGET.test(body);
  }
  return false;
}

/**
 * What a repository's CI actually runs, for the stacks no rule above knows.
 *
 * A workflow is the one machine-readable statement of "what a clean machine does
 * with this repository" that exists in every language. `Bun.YAML` already parses
 * this project's own config and roles, so reading one costs no dependency.
 */
/** Deliberately literal: a step is taken only if it could be typed as a template.
 *  `lease.ts` tokenises on whitespace and never invokes a shell, so `a && b` would
 *  pass `&&` to `a` as an argument — a command that looks like it ran and did half
 *  of nothing. Shell grammar, a redirect, a substitution or an expression only the
 *  runner can expand: left for the boss to write instead. */
export const WORKFLOWS = ".github/workflows";

/** Shell grammar, and the expressions only the CI runner can expand. */
const NOT_A_TEMPLATE = /[|&;<>`$()]|\$\{\{/;

/**
 * Which gate a command is, by what it runs — not by the step's `name:`, which is
 * prose, in whichever of ten languages the author wrote it.
 */
const GATE_OF: [name: string, matches: RegExp][] = [
  ["typecheck", /\b(typecheck|type-check|tsc|mypy|pyright)\b/],
  ["lint", /\b(lint|clippy|eslint|oxlint|ruff|vet|fmt|format)\b/],
  // `runtest` is one word to dune, and `\btest\b` does not see it — the reason
  // this list is spellings rather than a stem. No `check`: measured against this
  // repository's own workflows it took `bun run i18n:check` as the test gate,
  // with `bun run test` four steps further down the same file.
  ["test", /\b(test|tests|runtest|pytest|jest|vitest|rspec)\b/],
  ["build", /\bbuild\b/],
];

/** One pattern per gate, since a CI-derived command carries no stack with it. */
const GATE_ERROR: Record<string, string> = {
  typecheck: "(error|Error)",
  lint: "(error|warning|Error)",
  test: "(FAIL|failed|error|Error)",
  build: "(error|ERROR|failed)",
};

/** One workflow's runnable lines, or none: a file this cannot parse is GitHub's
 *  problem to report, not a reason to leave the project with no gates at all. */
function commandsIn(body: string): string[] {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(body);
  } catch {
    return [];
  }
  return runsIn(doc)
    .flatMap((run) => run.split("\n"))
    .map((line) => line.trim())
    .filter((cmd) => cmd && !cmd.startsWith("#") && !NOT_A_TEMPLATE.test(cmd));
}

/** Every `run:` line of every workflow, in file order, as candidate commands. */
function ciCommands(repo: Root): string[] {
  return [...(repo.list?.(WORKFLOWS) ?? [])]
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .flatMap((file) => commandsIn(repo.read(`${WORKFLOWS}/${file}`) ?? ""));
}

/**
 * `jobs.*.steps[].run`, walked structurally rather than by key name at depth: a
 * reusable workflow nests its jobs, and a matrix step is still a step.
 */
function runsIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(runsIn);
  if (node === null || typeof node !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "run" && typeof value === "string") out.push(value);
    else out.push(...runsIn(value));
  }
  return out;
}

function detectFromCi(repo: Root): DetectedGate[] {
  const commands = ciCommands(repo);
  const gates: DetectedGate[] = [];
  for (const [name, matches] of GATE_OF) {
    const candidates = commands.filter((cmd) => matches.test(cmd) && !gates.some((g) => g.template === cmd));
    // A command whose last word *is* the gate's own name is that gate; anything
    // else merely mentions it. Measured: `bun run format:check` and `bun run lint`
    // are both lint-shaped, and the second is the one the project calls lint.
    // Failing that, the first in file order — CI runs the cheap check first.
    // Split rather than a constructed pattern: `new RegExp` over a value is a
    // sink `fallow security` flags on sight, and it would be right to — the
    // difference between this table and one built from project config is one
    // refactor, and the check reads better as the question it is asking.
    const lastWord = (cmd: string) => cmd.split(/[\s:/]+/).at(-1);
    const found = candidates.find((cmd) => lastWord(cmd) === name) ?? candidates[0];
    if (found) gates.push({ name, template: found, errorRegex: GATE_ERROR[name] ?? "(error|Error)" });
  }
  return gates;
}

/**
 * What a `devcontainer.json` already says about this project's environment.
 *
 * It is the one file that states all three answers at once — which image, which
 * toolchains, what to run after a clone — in a spec somebody else maintains and
 * a growing number of repositories already ship. Read, never run: the CLI that
 * consumes this file creates containers, and we have one.
 */
/** The official feature namespace only. A feature id is `<registry>/<owner>/<name>:<featureVersion>`,
 *  and the *tool* version is in its options — `features/go:1` with `{version: "1.22"}`
 *  is Go 1.22 installed by version 1 of the feature. Third-party features do
 *  arbitrary things and are left alone. */
const FEATURE = /^ghcr\.io\/devcontainers\/features\/([a-z-]+):/;

/** Feature names that are a tool mise knows by the same name. The rest — docker-in-docker,
 *  git-lfs, a shell — are not toolchains and mise is not what installs them. */
const FEATURE_TOOLS = new Set(["go", "node", "python", "ruby", "rust", "java", "php", "dotnet", "deno", "bun"]);

export interface Devcontainer {
  /** The image the project develops in, for the boss to point the sandbox at. */
  image?: string;
  /** `TOOL@VERSION` pairs, as `mise install` takes them. */
  tools: string[];
  /** What the file says to run once the clone exists. */
  setup?: string;
}

export function detectDevcontainer(repo: Root): Devcontainer | null {
  const body = repo.read(".devcontainer/devcontainer.json") ?? repo.read(".devcontainer.json");
  if (body === null) return null;
  const doc = parseJsonc(body);
  if (doc === null || typeof doc !== "object") return null;
  const parsed = DevcontainerSchema.safeParse(doc);
  if (!parsed.success) return null;
  const { image, features, postCreateCommand, updateContentCommand } = parsed.data;

  const tools: string[] = [];
  for (const [id, options] of Object.entries(features ?? {})) {
    const name = FEATURE.exec(id)?.[1];
    if (!name || !FEATURE_TOOLS.has(name)) continue;
    // `{version}` is the shape the spec gives, but a feature may be configured
    // with `true` or with options of its own — narrowed here rather than asserted.
    const version = FeatureVersion.safeParse(options).data?.version;
    tools.push(`${name}@${version ?? "latest"}`);
  }

  return {
    ...(image ? { image } : {}),
    tools,
    // A string is a shell command; an array is argv, which reads the same once
    // joined. An object is several named commands run in parallel, which is not
    // one setup step and is left for the bootstrap role to read.
    ...setupOf(updateContentCommand ?? postCreateCommand),
  };
}

const FeatureVersion = z.object({ version: z.string().optional() }).loose();
const Command = z.union([z.string(), z.array(z.string()), z.record(z.string(), z.json())]).optional();
const DevcontainerSchema = z.object({
  image: z.string().optional(),
  features: z.record(z.string(), z.union([z.object({ version: z.string().optional() }).loose(), z.json()])).optional(),
  postCreateCommand: Command,
  updateContentCommand: Command,
});

function setupOf(command: z.infer<typeof Command>): { setup?: string } {
  if (typeof command === "string" && command.trim()) return { setup: command.trim() };
  if (Array.isArray(command) && command.length) return { setup: command.join(" ") };
  return {};
}

/**
 * The files a repository uses to pin its toolchain — every one of them a file
 * mise already reads, which is why this is a list of names and not a parser.
 *
 * `go.mod` is not here: it pins a Go version in a line rather than a file, and
 * mise reads it as one of the idiomatic sources the image enables.
 */
const TOOL_VERSIONS = [
  "mise.toml",
  ".mise.toml",
  ".tool-versions",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".go-version",
  ".ruby-version",
  ".java-version",
  "go.mod",
];

/**
 * How to put this repository's own toolchain in the container, or null.
 *
 * One command, because the answer to "which compiler, at which version" is
 * already written in the repository and mise is the thing that reads all nine
 * ways of writing it. What this must never become is a table of languages: that
 * is the shape `detectGates` is being moved *away* from, and a toolchain table
 * would be the same table with longer rows.
 */
export function detectToolchain(repo: Root): string | null {
  // A devcontainer's features name the tools outright, and `mise install` takes
  // `TOOL@VERSION` arguments — so a repository that pins its Go in a feature and
  // nowhere else still gets a Go, without a table of languages appearing here.
  const named = detectDevcontainer(repo)?.tools ?? [];
  if (named.length) return `mise install --yes ${named.join(" ")}`;
  return TOOL_VERSIONS.some((f) => hasFile(repo, f)) ? "mise install --yes" : null;
}

/** A `tasks:` map with a `test` in it, which is what `task test` needs to exist. */
function taskIn(repo: Root, file: string): boolean {
  const body = repo.read(file);
  if (body === null) return false;
  try {
    return TaskfileSchema.safeParse(Bun.YAML.parse(body)).data?.tasks?.test !== undefined;
  } catch {
    return false;
  }
}

/** `[tasks.test]` in a mise config, which `mise run test` needs. */
function miseTask(repo: Root, file: string): boolean {
  const body = repo.read(file);
  if (body === null) return false;
  try {
    return MiseSchema.safeParse(Bun.TOML.parse(body)).data?.tasks?.test !== undefined;
  } catch {
    return false;
  }
}

const TaskfileSchema = z.object({ tasks: z.record(z.string(), z.json()).optional() });
const MiseSchema = z.object({ tasks: z.record(z.string(), z.json()).optional() });

/** The install command for whichever stack this repo is, or null. */
export function detectInstall(repo: Root): string | null {
  for (const r of RULES) if (r.marker(repo)) return r.install?.(repo) ?? null;
  // What the repository itself says to run after a clone. Below the rules rather
  // than above them: a rule fires on a lockfile, which is the stronger statement
  // of the two — `postCreateCommand` is often a whole developer setup where the
  // lockfile names the one command a build needs.
  return detectDevcontainer(repo)?.setup ?? null;
}

export function detectGates(repo: Root): DetectedGate[] {
  for (const rule of RULES) {
    if (!rule.marker(repo)) continue;
    const gates = rule.gates(repo);
    if (gates.length) return gates;
  }
  // Only when the table above knows nothing. A recognised stack keeps its
  // convention: a CI step is written for a machine that has the services CI
  // starts, and this repository is its own example — `bun run test` there needs a
  // PostgreSQL container. The fallback is for the stacks no table has a row for,
  // where the alternative is not a worse gate but no gate at all, and `runGates`
  // fails every slice of a project it has nothing to run.
  return detectFromCi(repo);
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
