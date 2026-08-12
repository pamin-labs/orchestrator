import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Clearance profiles are Claude Code sandbox settings, generated per group.
 *
 * The key names and their semantics were measured, not read off docs — see
 * docs/decisions/001-agent-transport-and-sandbox.md. Three findings shape this
 * whole file:
 *
 *  - Writes are NOT confined to cwd by default. Without denyWrite an agent can
 *    write anywhere.
 *  - `allowWrite` cannot carve an exception out of a broader `denyWrite`; deny
 *    always wins. So confinement is deny-only and must be generated per group.
 *  - Every misconfiguration failed *silently* (sandbox simply absent), which is
 *    why `failIfUnavailable` is not optional.
 */

export type Clearance = "L1" | "L2";

export interface ProfileInput {
  clearance: Clearance;
  /** The group's worktree. Lives outside $HOME so denying $HOME is safe. */
  worktree: string;
  /** The project's main checkout — never writable from inside a group. */
  repoPath: string;
  /** Other groups' worktrees. Cross-group writes are how parallel groups corrupt each other. */
  siblingWorktrees?: string[];
  /** Extra paths this role may not read (per-project secrets, etc). */
  extraDenyRead?: string[];
  /**
   * Paths inside the worktree this group does not own. Generated from the
   * ownership globs, since "only these are writable" cannot be expressed with a
   * deny-only sandbox.
   */
  extraDenyWrite?: string[];
}

/** Secrets an agent must never read, regardless of clearance. */
export function secretDenyRead(home = homedir()): string[] {
  return [
    join(home, ".ssh/**"),
    join(home, ".aws/**"),
    join(home, ".gnupg/**"),
    join(home, ".config/gh/**"),
    join(home, ".claude/**"),
    join(home, ".codex/**"),
    join(home, ".netrc"),
    join(home, "Library/Keychains/**"),
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/id_rsa*",
    "**/id_ed25519*",
  ];
}

export function buildProfile(input: ProfileInput): Record<string, unknown> {
  const home = homedir();
  const denyWrite = [
    // The machine itself.
    join(home, ".ssh/**"),
    join(home, ".aws/**"),
    join(home, ".config/**"),
    join(home, ".claude/**"),
    join(home, ".codex/**"),
    join(home, "Library/**"),
    join(home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".profile"),
    "/etc/**",
    "/usr/**",
    "/Library/**",
    // Other groups' work, and the main checkout: a group only ever writes its
    // own worktree, and `orch git` performs repo-level writes on the host.
    join(input.repoPath, "**"),
    ...(input.siblingWorktrees ?? []).map((w) => join(w, "**")),
    ...(input.extraDenyWrite ?? []),
  ];

  if (input.clearance === "L1") {
    // L1 cannot touch dependency or CI config even inside its own worktree;
    // that is an L2 decision with blast radius beyond the group.
    denyWrite.push(
      join(input.worktree, "package.json"),
      join(input.worktree, "bun.lock"),
      join(input.worktree, "package-lock.json"),
      join(input.worktree, ".github/**"),
      join(input.worktree, "profiles/**"),
    );
  }

  return {
    sandbox: {
      enabled: true,
      // Every misconfiguration observed during the probe failed silently, with
      // the sandbox simply absent. Refusing to start is the only safe default.
      failIfUnavailable: true,
      // A headless run cannot show a permission prompt: without this every
      // Bash call is denied, and the agent quietly invents a workaround.
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: [...secretDenyRead(home), ...(input.extraDenyRead ?? [])],
        denyWrite,
      },
      network: {
        // orch runs over localhost TCP. Unix sockets stay shut because
        // allowAllUnixSockets would also open /var/run/docker.sock, which is a
        // one-line host escape and which filesystem deny rules do not close.
        allowLocalBinding: true,
        allowAllUnixSockets: false,
      },
    },
  };
}

/**
 * Read-only shell every role needs.
 *
 * Measured: without these, planning roles burned turns on denied `ls`, `cat` and
 * `find` calls — and a denial in headless mode is silent, so they simply looked
 * confused. None of these can change anything; `orch` remains the only channel
 * through which an agent affects the world.
 */
const READ_SHELL = [
  "Bash(ls*)",
  "Bash(cat*)",
  "Bash(head*)",
  "Bash(tail*)",
  "Bash(wc*)",
  "Bash(find*)",
  "Bash(grep*)",
  "Bash(rg*)",
  "Bash(git log*)",
  "Bash(git diff*)",
  "Bash(git show*)",
  "Bash(git status*)",
  "Bash(echo*)",
  // Every segment of a compound command must match, so a missing read-only
  // builtin blocks the whole line. Live, the Auditor lost a step to
  // `… && (test -f tsconfig.json && cat …)`.
  "Bash(cd*)",
  "Bash(pwd*)",
  "Bash(test*)",
  "Bash(basename*)",
  "Bash(dirname*)",
];

/** Tools each clearance may use. QA's list is deliberately narrow. */
export function allowedToolsFor(role: string, clearance: Clearance): string[] {
  const base = ["Bash(orch *)", ...READ_SHELL];
  switch (role) {
    case "qa":
      // QA reviews the diff, the acceptance spec and the gate output — never the
      // whole repo. Re-reading a module costs about as much as writing it, and
      // the information a review needs is in the diff. No unconstrained Read.
      return [...base, "Grep"];
    case "engineer":
      return [...base, "Read", "Edit", "Write", "Grep", "Glob"];
    case "pm":
    case "dispatcher":
    case "architect":
    case "cos":
      return [...base, "Read", "Grep", "Glob"];
    case "librarian":
      return [...base, "Read", "Grep"];
    default:
      return clearance === "L2" ? [...base, "Read", "Grep", "Glob"] : [...base, "Read"];
  }
}

/** Write the profile to disk and return its path (goes into `--settings`). */
export function writeProfile(dir: string, name: string, input: ProfileInput): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(buildProfile(input), null, 2), "utf8");
  return path;
}
