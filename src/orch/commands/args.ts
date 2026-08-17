import { parseArgs as tokenize } from "node:util";

export interface Parsed {
  flags: Record<string, string | string[] | true>;
  args: string[];
  /** Everything after a bare `--`, passed through untouched. */
  rest: string[];
}

function addFlag(flags: Parsed["flags"], key: string, value: string | true): void {
  const previous = flags[key];
  flags[key] =
    value === true || previous === undefined || previous === true
      ? value
      : [...(Array.isArray(previous) ? previous : [previous]), value];
}

/**
 * Command line into flags, positionals, and whatever follows a bare `--`.
 *
 * The splitting is `node:util`'s, which is the part that has to agree with every
 * other CLI a person has used. The hand-written loop this replaced did not:
 * `--claim=text` produced a flag literally named `claim=text` set to `true`, and
 * the value vanished. Commands that read a missing flag fall back to standard
 * input, so the whole command hung on a terminal instead of reporting anything.
 *
 * Options are not declared, so `strict` is off and the shape is read from
 * `tokens`: an option with no inline value takes the next positional, which is
 * the convention the rest of the CLI's usage text describes.
 */
export function parseArgs(argv: string[]): Parsed {
  const { tokens } = tokenize({ args: argv, strict: false, allowPositionals: true, tokens: true });
  const parsed: Parsed = { flags: {}, args: [], rest: [] };
  let awaiting: string | undefined;
  let terminated = false;

  for (const token of tokens) {
    if (terminated) {
      if (token.kind === "positional") parsed.rest.push(token.value);
      continue;
    }
    if (awaiting !== undefined && token.kind !== "positional") {
      addFlag(parsed.flags, awaiting, true);
      awaiting = undefined;
    }
    if (token.kind === "option-terminator") {
      terminated = true;
    } else if (token.kind === "option") {
      const name = token.rawName === "-h" ? "help" : token.name;
      if (token.value === undefined) awaiting = name;
      else addFlag(parsed.flags, name, token.value);
    } else if (awaiting !== undefined) {
      addFlag(parsed.flags, awaiting, token.value);
      awaiting = undefined;
    } else {
      parsed.args.push(token.value);
    }
  }
  if (awaiting !== undefined) addFlag(parsed.flags, awaiting, true);
  return parsed;
}

export const list = (value: Parsed["flags"][string] | undefined): string[] =>
  Array.isArray(value) ? value : typeof value === "string" ? [value] : [];

export const scalar = (value: Parsed["flags"][string] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/** `--arg k=v --arg j=w` -> `{k: "v", j: "w"}` */
export function kvArgs(value: Parsed["flags"][string] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of list(value)) {
    const equals = pair.indexOf("=");
    if (equals > 0) out[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return out;
}
