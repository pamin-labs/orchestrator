/**
 * Pull the attachment list back out of a message.
 *
 * `withAttachments` on the server appends the files to the text as paths, which
 * is right for the agents — a path costs a dozen tokens and an image costs
 * thousands on every turn that carries it. But the panel is a browser, and the
 * boss's own screenshot came back to them as a line of text naming a file they
 * could not open. The block is machine-written and fixed, so reading it back is
 * a parse, not a guess.
 */
export interface Attached {
  /** 图1 / 附件2, when the message that carried it named its files. */
  label: string;
  name: string;
  path: string;
  /** Where the panel can fetch it. */
  url: string;
  image: boolean;
}

// i18n-exempt: matches the header an agent writes into a message body, which
// follows `output.language` rather than this panel.
const HEAD = /\n*附件（路径如下）：\n/;

export function splitAttachments(body: string): { text: string; files: Attached[] } {
  const at = body.search(HEAD);
  if (at < 0) return { text: body, files: [] };
  const head = HEAD.exec(body.slice(at))!;
  const files: Attached[] = [];
  for (const line of body.slice(at + head[0].length).split("\n")) {
    const m = /^- (?:\[([^\]]+)\] )?(\S+)( \(image\))?\s*$/.exec(line);
    // A line that is not an entry ends the block: the list is always last, but a
    // message that merely contains the words should not swallow its own body.
    if (!m) break;
    const path = m[2]!;
    files.push({
      label: m[1] ?? "",
      name: path.split("/").pop() ?? path,
      path,
      url: `/api/v1/attach/${encodeURIComponent(path.split("/").pop() ?? "")}`,
      image: !!m[3],
    });
  }
  return files.length ? { text: body.slice(0, at).trimEnd(), files } : { text: body, files: [] };
}
