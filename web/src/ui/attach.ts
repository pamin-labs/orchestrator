/**
 * Pull the attachment list back out of a message.
 *
 * `withAttachments` on the server appends the files to the text as paths, which
 * is right for the agents — a path costs a dozen tokens and an image costs
 * thousands on every turn that carries it. But the panel is a browser, and the
 * boss's own screenshot came back to them as a line of text naming a file they
 * could not open.
 */
export interface Attached {
  /** `Image1` / `Attach2` — the marker the message that carried it used. */
  label: string;
  name: string;
  path: string;
  /** Where the panel can fetch it. */
  url: string;
  image: boolean;
}

/**
 * One entry. The path must contain a `/`, which is what keeps an ordinary
 * markdown list in the boss's own message from being read as attachments.
 */
const ITEM = /^- (?:\[([^\]]+)\] )?(\S*\/\S*)( \(image\))?\s*$/;

/**
 * Found by its shape, not by its header.
 *
 * The header was matched as a literal — the same sentence typed into this file
 * and into `mech/util/attachment-text.ts` — which is prose as a protocol key,
 * and pinned the panel to whichever language the server wrote it in.
 */
/** `withAttachments` writes `text`, a blank line, the header, then entries to
 *  the end. So the trailing run of entries plus the line above it is the block,
 *  whatever that line says. */
export function splitAttachments(body: string): { text: string; files: Attached[] } {
  const lines = body.split("\n");
  let at = lines.length;
  while (at > 0 && ITEM.test(lines[at - 1]!)) at--;
  // `at - 1` is the header and `at - 2` the blank line before it. Without that
  // blank this is a list somebody wrote, not a block somebody appended.
  if (at === lines.length || at < 2 || lines[at - 2] !== "") return { text: body, files: [] };

  const files = lines.slice(at).map((line) => {
    const m = ITEM.exec(line)!;
    const path = m[2]!;
    return {
      label: m[1] ?? "",
      name: path.split("/").pop() ?? path,
      path,
      url: `/api/v1/attach/${encodeURIComponent(path.split("/").pop() ?? "")}`,
      image: !!m[3],
    };
  });
  return {
    text: lines
      .slice(0, at - 2)
      .join("\n")
      .trimEnd(),
    files,
  };
}
