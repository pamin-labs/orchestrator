import type { DB } from "../../db.ts";
import { hasRegistry, PUBLISHED_REPO } from "./sandbox.ts";

/**
 * What the image field may be set to, as two lists rather than a text box.
 *
 * Typing an image name is the shape of field that fails four steps later: a
 * typo is not rejected here, it is a container that will not create, on a group
 * that has already been dispatched. And the set of legal answers is small and
 * knowable — `allowedImage` accepts exactly two families — so the panel can just
 * show them.
 *
 * Both sides are best-effort and say which kind of empty they are. "No published
 * versions" and "could not reach the registry" send a reader to different places,
 * and collapsing them into one blank list is the failure mode this project keeps
 * paying for.
 */

export interface ImageChoices {
  /** Tags of the published agent image, newest-looking first. */
  published: string[];
  /** Images on this machine's docker, in `repo:tag` form. */
  local: string[];
  /** Why a list is empty, when it is empty for a reason worth saying. */
  note: { published?: string; local?: string };
}

/**
 * Tags from the registry, over the anonymous pull token.
 *
 * A public package needs no credential — GHCR hands out a scoped read token to
 * anyone who asks — which is the reason this does not go through the GitHub App:
 * the panel should be able to list versions before anybody has connected an
 * account.
 */
async function published(): Promise<{ tags: string[]; note?: string }> {
  const repo = PUBLISHED_REPO;
  try {
    const auth = await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull`, {
      signal: AbortSignal.timeout(6000),
    });
    const token = ((await auth.json()) as { token?: string }).token;
    if (!token) return { tags: [], note: "拿不到 registry 的读取令牌" };

    const res = await fetch(`https://ghcr.io/v2/${repo}/tags/list?n=100`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      // The package has never been published, or is private. Both look the same
      // from here, and both mean "nothing to choose yet" rather than "broken".
      return { tags: [], note: "还没发布过镜像 —— 先跑一次 release，或者用本地构建的" };
    }
    if (!res.ok) return { tags: [], note: `registry 答 HTTP ${res.status}` };
    const tags = ((await res.json()) as { tags?: string[] }).tags ?? [];
    // `latest` first, then the rest newest-looking first. Not a semver sort:
    // whatever a release tags is the release's business, and inventing an order
    // it did not ask for is how a "newest" ends up pointing at the wrong one.
    return { tags: [...tags].sort((a, b) => (a === "latest" ? -1 : b === "latest" ? 1 : b.localeCompare(a, undefined, { numeric: true }))) };
  } catch (e) {
    return { tags: [], note: `连不上 ghcr.io：${String((e as Error)?.message ?? e).slice(0, 80)}` };
  }
}

/**
 * Images on this machine, for the local half.
 *
 * Only the ones `allowedImage` would accept — anything with a registry in front
 * of it is on this machine because it was pulled from somewhere, and offering it
 * here would be the panel suggesting the thing the boundary refuses.
 */
function local(): { tags: string[]; note?: string } {
  try {
    const p = Bun.spawnSync(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) return { tags: [], note: "docker 没应答 —— 它没起来的话这里就是空的" };
    const all = p.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.includes("<none>"));
    const mine = all.filter((r) => !hasRegistry(r));
    return { tags: mine, note: mine.length ? undefined : "本机没有可用的镜像 —— docker build 一个再回来" };
  } catch {
    return { tags: [], note: "这台机器上没有 docker" };
  }
}

export async function imageChoices(): Promise<ImageChoices> {
  const [p, l] = [await published(), local()];
  return {
    published: p.tags.map((t) => `ghcr.io/${PUBLISHED_REPO}:${t}`),
    local: l.tags,
    note: { ...(p.note ? { published: p.note } : {}), ...(l.note ? { local: l.note } : {}) },
  };
}

/**
 * The image every project gets unless it says otherwise.
 *
 * In `setting` rather than in the yaml, for the same reason the sandbox key is:
 * the yaml is committed, so anybody self-hosting loses their edit on the next
 * pull — and this is a fact about one machine's docker, not about the project.
 * The yaml value stays as the fallback, which is what a fresh install runs on.
 *
 * Refused if the boundary would refuse it. Storing an image no container can be
 * built from turns one wrong keystroke in the settings dialog into a fleet that
 * will not start, and the message would be about a container rather than about
 * this field.
 */
export const DEFAULT_IMAGE_KEY = "sandbox_image";

export const defaultImage = (db: DB, fallback: string): string =>
  db.query<{ v: string }, [string]>("SELECT v FROM setting WHERE k = ?").get(DEFAULT_IMAGE_KEY)?.v || fallback;

export function setDefaultImage(db: DB, ref: string): void {
  const image = ref.trim();
  if (!image) return void db.run("DELETE FROM setting WHERE k = ?", [DEFAULT_IMAGE_KEY]);
  db.run("INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [
    DEFAULT_IMAGE_KEY,
    image,
  ]);
}
