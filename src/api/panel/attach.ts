import { basename, dirname, join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { Attachment as AttachmentSchema } from "../fields.ts";
import { bad, json, text, type Handler } from "../shared.ts";
import type { Ctx } from "../../ctx.ts";
import { sediment } from "../../mech/knowledge/lessons.ts";

export const AttachmentNameParams = z.object({ name: z.string().min(1) });

/**
 * The same four fields `fields.ts` already validates at the door.
 *
 * This was a hand-written interface beside the zod schema every route runs, so
 * "what is an attachment" had two answers and only one of them was checked. A
 * field added to the schema would not have reached `withAttachments`.
 */
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * Words plus the files that came with them.
 *
 * Paths, never contents: an image inlined into a prompt costs thousands of tokens
 * on every turn that carries it, a path costs a dozen and the agent opens it once
 * when it needs to. Shared by every route the boss can attach to — an idea, a
 * sent-back card, a rejected slice, a remark to the group.
 *
 * The image tag is ASCII and fixed because it is read back by machine: codex has
 * no file tool that opens an image, so those paths have to leave here and come
 * back as `-i` flags (imagePaths below). The wording no longer names a tool —
 * `Read` exists on one of the two CLIs.
 */
const IMAGE_TAG = " (image)";

/**
 * `~` as the person typing it means it.
 *
 * Only the two host-browsing paths use this now — the attachment picker and the
 * directory listing behind it. A project is a repository, not a directory.
 */
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Files the boss hands to an agent, and the one note the boss writes directly.
 *
 * Attachments are staged rather than inlined: the prompt carries a path, the
 * sandbox mounts the file, and only the image ones are pulled back out by name
 * for the CLIs that take `-i`. `bossFact` sits here because it is the same
 * shape — the boss saying something that has to survive as a note.
 */

/**
 * Files that come with an idea: a screenshot of the bug, a mock, a spec.
 *
 * Saved on disk and referenced by absolute path, never inlined: an image in a
 * prompt is worth thousands of tokens on every turn that carries it, while a path
 * costs a dozen and the agent can open it with Read exactly once, when it needs to.
 */
export const postAttach: Handler = async (ctx, req) => {
  const form = await req.formData();
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  // Each file's path relative to what was dropped. A loose file has none; a file
  // from inside a dropped folder has `<folder>/…/name`, and the folder is what the
  // boss meant to attach — "看这个目录" is one reference, not forty.
  const rels = form.getAll("rel").map((r) => String(r));
  if (!files.length) return bad("no file");
  const root = join(ctx.config.dataDir ?? "data", "attachments");
  const out: { name: string; path: string; type: string; size: number }[] = [];
  const dirs = new Map<string, { path: string; bytes: number }>();
  const stamp = Date.now();

  for (const [i, f] of files.entries()) {
    if (f.size > 25 * 1024 * 1024) return bad(`${f.name} 超过 25MB`);
    // The stamp keeps two screenshots called "Screenshot.png" apart, and the
    // sanitising keeps a crafted filename inside the directory. Every segment of
    // a relative path is sanitised the same way, so `..` cannot survive one.
    const safe = (s: string) => s.replace(/[^\w.\-\u4e00-\u9fff]/g, "_").slice(-80);
    const rel = (rels[i] ?? "").split("/").filter((s) => s && s !== "." && s !== "..").map(safe);
    if (rel.length > 1) {
      const top = rel[0]!;
      const base = dirs.get(top)?.path ?? join(root, `${stamp}-${top}`);
      const path = join(base, ...rel.slice(1));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(await f.arrayBuffer()));
      dirs.set(top, { path: base, bytes: (dirs.get(top)?.bytes ?? 0) + f.size });
      continue;
    }
    await mkdir(root, { recursive: true });
    const path = join(root, `${stamp}-${out.length}-${safe(f.name)}`);
    await writeFile(path, Buffer.from(await f.arrayBuffer()));
    out.push({ name: f.name, path, type: f.type || "application/octet-stream", size: f.size });
  }

  // A directory is one attachment: the path, for an agent to walk.
  for (const [name, d] of dirs) {
    out.push({ name, path: d.path, type: "inode/directory", size: d.bytes });
  }
  return json({ files: out });
};

/**
 * Attach something already on this machine, by path.
 *
 * The upload route exists because a browser cannot hand over a real path — but
 * the boss picking through their own disk in our own picker is not a browser
 * upload, and round-tripping a 400MB folder through a file input to write it back
 * to the same disk is absurd. Copied rather than referenced in place: the file
 * the agent reads has to still be there when it reads it, and the boss's working
 * copy moves.
 */
export const LocalPathsBody = z.object({ paths: z.array(z.string().max(4000)).max(200).default([]) });

export const postAttachLocal: Handler<z.infer<typeof LocalPathsBody>> = async (ctx, _req, _p, b) => {
  const picked = b.paths.filter((s) => s.trim());
  if (!picked.length) return bad("no path");
  const root = join(ctx.config.dataDir ?? "data", "attachments");
  await mkdir(root, { recursive: true });
  const stamp = Date.now();
  const out: { name: string; path: string; type: string; size: number }[] = [];
  for (const raw of picked) {
    const src = resolve(expandHome(raw));
    let st;
    try {
      st = statSync(src);
    } catch {
      return bad(`${raw}: 读不到`);
    }
    const safe = basename(src).replace(/[^\w.\-\u4e00-\u9fff]/g, "_").slice(-80);
    const dest = join(root, `${stamp}-${out.length}-${safe}`);
    await cp(src, dest, { recursive: st.isDirectory() });
    out.push({
      name: basename(src),
      path: dest,
      // `Bun.file(path).type` is the same question the upload route below already
      // asks this way, and it does not need the file to exist. A six-extension
      // table beside it was two mechanisms for one answer in one file.
      type: st.isDirectory() ? "inode/directory" : Bun.file(src).type || "application/octet-stream",
      size: st.size,
    });
  }
  return json({ files: out });
};

/**
 * Hand one attachment back to the panel.
 *
 * The files were written to `data/attachments` and referenced by absolute path
 * from the first version, which is what an agent needs — but the panel is a
 * browser, and a browser cannot open a path. So the boss's own screenshot,
 * attached to the question the boss is being asked, rendered as a line of text
 * naming a file they could not see.
 *
 * Basename only: the stored name is already sanitised on the way in, and taking
 * only the last segment means a path that arrives with `..` in it resolves to a
 * file that does not exist rather than to one outside the directory.
 */
export const getAttachment: Handler<undefined, z.infer<typeof AttachmentNameParams>> = async (ctx, _req, params) => {
  const name = basename(params.name);
  const path = join(ctx.config.dataDir ?? "data", "attachments", name);
  if (!name || !existsSync(path)) return text("no such attachment", 404);
  const f = Bun.file(path);
  // Served same-origin, from the origin that has every API route on it and no
  // login in front of them. An `.svg` or an `.html` here is a script running as
  // the panel — the one path around React's escaping, and the uploads are not
  // all the boss's: `attach/local` is reachable by anything holding an agent
  // token.
  //
  // Three headers, and each one closes a different half of that:
  //
  //   inline only for what has to render (images, pdf); everything else
  //     downloads instead of executing, which is the whole of the `.html` case
  //   nosniff, or an unknown type is guessed at by the browser and a text/plain
  //     file full of markup becomes markup again
  //   a CSP with no `script-src` at all, for the types that do render — an SVG
  //     is an image and a document, and this is what stops the second half
  const type = f.type || "application/octet-stream";
  const renders = /^image\/(png|jpeg|gif|webp|avif)$|^application\/pdf$/.test(type);
  return new Response(f, {
    headers: {
      "content-type": type,
      "content-disposition": `${renders ? "inline" : "attachment"}; filename="${name.replace(/["\\]/g, "")}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      // Content-addressed by name — every upload carries its own timestamp, so a
      // given URL never changes.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
};

/**
 * The boss said something that should stick. One helper, because "record it and see if
 * it is the third time" must not be remembered separately at four call sites.
 */
export function bossFact(ctx: Ctx, grpId: number | null, body: string): void {
  const projectId = grpId
    ? ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId)
        ?.project_id ?? null
    : null;
  ctx.db.run(
    "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (?, ?, 'fact', ?, ?, unixepoch() * 1000)",
    [projectId, grpId, ctx.config.language, body],
  );
  sediment(ctx, projectId, ctx.config.feedbackSedimentThreshold ?? 3);
}

export function withAttachments(text: string, attachments?: Attachment[]): string {
  const files = (attachments ?? []).filter((f) => f?.path);
  if (!files.length) return text;
  // The label goes on the path, because the words above it use the same marker.
  // Without it, "按 [图2] 改" is a reference into a list of three bare paths.
  return (
    `${text}\n\n附件（路径如下）：\n` +
    files
      .map((f) => `- ${f.label ? `[${f.label}] ` : ""}${f.path}${f.type?.startsWith("image/") ? IMAGE_TAG : ""}`)
      .join("\n")
  );
}

/** The image attachments in an assembled prompt, for CLIs that need them as flags. */
export function imagePaths(prompt: string): string[] {
  // The escape used to list the metacharacters IMAGE_TAG happens to contain, so
  // it was correct only for the tag's current spelling.
  const re = new RegExp(`^- (?:\\[[^\\]]+\\] )?(\\S+)${RegExp.escape(IMAGE_TAG)}$`, "gm");
  return [...prompt.matchAll(re)].map((m) => m[1]!);
}
