/**
 * JSON with comments and trailing commas, which is what `devcontainer.json` is.
 *
 * Written here rather than rented, and the evidence is the registry: the correct
 * library is `jsonc-parser` (Microsoft, no dependencies) whose last release was
 * 2024-06 — over a year, which `docs/standards/dependencies.md` says to ignore.
 * `json5` is 2022. `comment-json` is current and pulls `esprima`, a whole
 * JavaScript parser, to strip comments. Reopen if any of them ships again.
 */
/**
 * A pass over the text, not a regex, because a regex cannot see that the `//` in
 * `"image": "ghcr.io/x"` is inside a string — the exact defect that makes the
 * ten-line version of this wrong on the first real file it meets.
 */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    return null;
  }
}

export function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      i = endOfLine(text, i);
    } else if (c === "/" && text[i + 1] === "*") {
      i = endOfBlock(text, i);
    } else if (c === "," && closesNext(text, i)) {
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Past the closing quote. A backslash escapes what follows — including a quote
 *  and itself — so both characters move together or `"a\\"` ends one short. */
function endOfString(text: string, at: number): number {
  let i = at + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  return i;
}

/** Past the newline, or to the end. */
function endOfLine(text: string, at: number): number {
  const nl = text.indexOf("\n", at);
  return nl === -1 ? text.length : nl;
}

/** Past the closing delimiter, or to the end — an unterminated block eats the rest, as a reader does. */
function endOfBlock(text: string, at: number): number {
  const close = text.indexOf("*/", at + 2);
  return close === -1 ? text.length : close + 2;
}

/** Nothing but whitespace between this comma and a close: it is trailing. */
function closesNext(text: string, at: number): boolean {
  let i = at + 1;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return text[i] === "}" || text[i] === "]";
}
