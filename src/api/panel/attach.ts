import { msg } from "@lingui/core/macro";
import { eq } from "drizzle-orm";
import { basename, dirname, join, resolve } from "node:path";
import { addNote } from "../../mech/util/rows.ts";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Ctx } from "../../mech/ctx.ts";
import type { Handler } from "../../http/handler.ts";
import { bad, json, message } from "../../http/respond.ts";

import { sediment } from "../../mech/knowledge/lessons.ts";
import { grp } from "../../platform/persistence/schema.ts";

export const AttachmentNameParams = z.object({ name: z.string().min(1) });

/**
 * The same four fields `fields.ts` already validates at the door.
 *
 * This was a hand-written interface beside the zod schema every route runs, so
 * "what is an attachment" had two answers and only one of them was checked. A
 * field added to the schema would not have reached `withAttachments`.
 */
/**
 * Words plus the files that came with them.
 *
 * Paths, never contents: an image inlined into a prompt costs thousands of tokens on
 * every turn that carries it, a path costs a dozen and the agent opens it once.
 * Shared by every route the boss can attach to.
 */
/**
 * The image tag is ASCII and fixed because it is read back by machine: codex has no
 * file tool that opens an image, so those paths have to leave here and come back as
 * `-i` flags. The wording no longer names a tool — `Read` exists on one of the two
 * CLIs.
 */
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
export const AttachForm = z.object({
  file: z
    .union([z.instanceof(File), z.array(z.instanceof(File))])
    .transform((value) => (Array.isArray(value) ? value : [value])),
  rel: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .default([]),
});

export const postAttach = (async (ctx, _req, _params, { file: files, rel: rels }) => {
  // Each file's path relative to what was dropped. A loose file has none; a file
  // from inside a dropped folder has `<folder>/…/name`, and the folder is what the
  // boss meant to attach — "看这个目录" is one reference, not forty.
  if (!files.length) return bad(msg`no file`);
  const root = join(ctx.config.dataDir, "attachments");
  const out: { name: string; path: string; type: string; size: number }[] = [];
  const dirs = new Map<string, { path: string; bytes: number }>();
  const stamp = Date.now();

  for (const [i, f] of files.entries()) {
    if (f.size > 25 * 1024 * 1024) return bad(msg`${{ name: f.name }} is over 25MB`);
    // The stamp keeps two screenshots called "Screenshot.png" apart, and the
    // sanitising keeps a crafted filename inside the directory. Every segment of
    // a relative path is sanitised the same way, so `..` cannot survive one.
    const safe = (s: string) => s.replace(/[^\w.\-\u4e00-\u9fff]/g, "_").slice(-80);
    const rel = (rels[i] ?? "")
      .split("/")
      .filter((s) => s && s !== "." && s !== "..")
      .map(safe);
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
}) satisfies Handler<z.output<typeof AttachForm>>;

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

export const postAttachLocal = (async (ctx, _req, _p, b) => {
  const picked = b.paths.filter((s) => s.trim());
  if (!picked.length) return bad(msg`no path`);
  const root = join(ctx.config.dataDir, "attachments");
  await mkdir(root, { recursive: true });
  const stamp = Date.now();
  const out: { name: string; path: string; type: string; size: number }[] = [];
  for (const raw of picked) {
    const src = resolve(expandHome(raw));
    let st;
    try {
      st = statSync(src);
    } catch {
      return bad(msg`${{ path: raw }}: cannot be read`);
    }
    const safe = basename(src)
      .replace(/[^\w.\-\u4e00-\u9fff]/g, "_")
      .slice(-80);
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
}) satisfies Handler<z.infer<typeof LocalPathsBody>>;

/**
 * Hand one attachment back to the panel.
 *
 * The files were written to `data/attachments` and referenced by absolute path,
 * which is what an agent needs — but a browser cannot open a path. So the boss's own
 * screenshot rendered as a line of text naming a file they could not see.
 *
 * Basename only: a path arriving with `..` then resolves to a file that does not
 * exist rather than to one outside the directory.
 */
export const getAttachment = (async (ctx, _req, params) => {
  const name = basename(params.name);
  const path = join(ctx.config.dataDir, "attachments", name);
  if (!name || !existsSync(path)) return message("no such attachment", 404);
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
}) satisfies Handler<undefined, z.infer<typeof AttachmentNameParams>>;

/**
 * The boss said something that should stick. One helper, because "record it and see if
 * it is the third time" must not be remembered separately at four call sites.
 */
export async function bossFact(ctx: Ctx, grpId: number | null, body: string): Promise<void> {
  const [owner] = grpId ? await ctx.db.select({ project_id: grp.project_id }).from(grp).where(eq(grp.id, grpId)) : [];
  const projectId = owner?.project_id ?? null;
  await addNote(ctx.db, { projectId, grpId, kind: "fact", lang: ctx.config.language, body });
  await sediment(ctx, projectId, ctx.config.feedbackSedimentThreshold);
}
