/**
 * What the project settings panes decide before they draw a control.
 *
 * Three of these carry a rule someone had to be told twice: gates run in the
 * order the list is in and nowhere else, a sandbox key that is cleared has to
 * leave the patch rather than be sent as `undefined`, and a blocked domain is a
 * host — not whatever was pasted. Each was a closure inside a component that
 * fetches its own data, so none of them could be asked a question without a
 * browser.
 */

/** A command this repository was detected to have. */
export interface Resource {
  name: string;
  template: string;
}

/**
 * The gates that run, in run order, and the ones that do not.
 *
 * `on` follows the stored list because that list *is* the order; `off` follows
 * the catalogue, which is alphabetical and has no order to lose. A stored gate
 * whose command no longer exists is dropped from both: the repository stopped
 * having it, and a row for a command nothing can run is a row that cannot pass.
 */
export function gateRows(gates: string[], resources: Resource[]): { on: string[]; off: Resource[] } {
  const on = gates.filter((g) => resources.some((r) => r.name === g));
  return { on, off: resources.filter((r) => !on.includes(r.name)) };
}

/** The command a gate runs, blank for a name the catalogue no longer has. */
export const gateTemplate = (resources: Resource[], name: string): string =>
  resources.find((r) => r.name === name)?.template ?? "";

/**
 * The list with one gate moved, or null when the drop changed nothing.
 *
 * Null rather than the same array: the caller writes what it gets back, and a
 * drag that ends where it started would otherwise be a save, a refetch, and a
 * 已保存 for a list identical to the one already stored.
 */
export function moveGate(list: string[], from: number, to: number): string[] | null {
  if (from < 0 || to < 0 || from === to || to >= list.length) return null;
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]!);
  return next;
}

/**
 * Which way an `Alt`+arrow moves a gate, or null for any other key. `Alt` and
 * not the bare arrow: the rows are a toggle group, where the arrows already move
 * focus between gates.
 */
export function arrowStep(altKey: boolean, key: string): -1 | 1 | null {
  if (!altKey) return null;
  if (key === "ArrowUp") return -1;
  return key === "ArrowDown" ? 1 : null;
}

/** The sandbox overrides a project stores; the subset this pane has a box for. */
export interface SandboxValues {
  image?: string | undefined;
  cpu?: string | undefined;
  memory?: string | undefined;
  denyDomains?: string[] | undefined;
  cacheDirs?: Record<string, string> | undefined;
}

/** `{"/a": "/b"}` as `/a:/b`, one pair per space. */
export const cacheDirsText = (dirs: Record<string, string>): string =>
  Object.entries(dirs)
    .map(([mount, host]) => `${mount}:${host}`)
    .join(" ");

/** Every box on the sandbox pane, as the string or list it shows. */
export interface SandboxRows {
  sandbox: SandboxValues;
  baseBranch: string;
  branches: string[];
  install: string;
  image: string;
  cpu: string;
  memory: string;
  denyDomains: string[];
  cacheDirs: string;
}

/**
 * Every absent override, as the empty box that means "inherit".
 *
 * One place rather than nine `??` in the markup, and one place is what makes the
 * rule assertable: an unset key must reach its control as empty, because an
 * empty box is how it is cleared again and a box showing the inherited value
 * would save that value as this project's own the first time it lost focus.
 */
export function sandboxRows(
  baseBranch: string | null,
  branches: string[] | undefined,
  install: string | null | undefined,
  sandbox: SandboxValues | undefined,
): SandboxRows {
  const box = sandbox ?? {};
  return {
    sandbox: box,
    baseBranch: baseBranch ?? "",
    branches: branches ?? [],
    install: install ?? "",
    image: box.image ?? "",
    cpu: box.cpu ?? "",
    memory: box.memory ?? "",
    denyDomains: box.denyDomains ?? [],
    cacheDirs: cacheDirsText(box.cacheDirs ?? {}),
  };
}

/**
 * One sandbox key set, or removed when it is cleared.
 *
 * Removed rather than set to `undefined`: the patch is serialised to JSON on the
 * way out, where an `undefined` value is not a key that was cleared — it is a
 * key that never appears, so the stored override would have survived every
 * attempt to take it off.
 */
export function sandboxSet(sandbox: SandboxValues, key: string, value: unknown): SandboxValues {
  const next: Record<string, unknown> = { ...sandbox };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * `mount:host` pairs back into a map, split at the last colon.
 *
 * Last, because the mount point is a path and a path may carry one; the host
 * side is what the sandbox server has to have listed, so a pair missing it is
 * dropped rather than stored as a mount onto nothing.
 */
export function cacheDirsFrom(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split(/\s+/)
      .filter(Boolean)
      .map((pair): [string, string] => {
        const at = pair.lastIndexOf(":");
        return at > 0 ? [pair.slice(0, at), pair.slice(at + 1)] : [pair, ""];
      })
      .filter(([, host]) => host),
  );
}

/**
 * Whatever was pasted, reduced to the host the egress sidecar matches on. A
 * scheme, a trailing path, a port, capitals — all of them are somebody meaning a
 * host, and all of them stored verbatim matched nothing.
 */
export const domainHost = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "");

/**
 * What a key does in the domain box: commit the draft, or take the last chip.
 * Backspace only on an empty box, and only when there is a chip to take.
 */
export function domainKey(key: string, draft: string, chips: number): "add" | "drop" | null {
  if (key === "Enter") return "add";
  return key === "Backspace" && !draft && chips > 0 ? "drop" : null;
}

/** Where an image name comes from. Published names carry a registry; a local build is the bare tag. */
export type ImageSource = "remote" | "local";

export const imageSource = (value: string): ImageSource =>
  value && !value.startsWith("ghcr.io/") ? "local" : "remote";

/** The two lists a sandbox image may be picked from, and what each empty means. */
export interface ImageChoiceSet {
  published: string[];
  local: string[];
  note: { published?: string | undefined; local?: string | undefined };
}

/**
 * The names one source offers and the sentence under them. The note is per
 * source because "nothing published yet" and "could not reach ghcr.io" are the
 * same empty list and send a reader to different places.
 */
export function imageOptions(
  src: ImageSource,
  choices: ImageChoiceSet | null,
): { options: string[]; note: string | undefined } {
  if (!choices) return { options: [], note: undefined };
  return src === "remote"
    ? { options: choices.published, note: choices.note.published }
    : { options: choices.local, note: choices.note.local };
}
