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
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      // A backslash escapes whatever follows, including a quote and itself, so
      // both characters move together or `"a\\"` ends the string one short.
      if (c === "\\" && i + 1 < text.length) out += text[++i]!;
      else if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // A comma with nothing but whitespace between it and the close is trailing.
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}
