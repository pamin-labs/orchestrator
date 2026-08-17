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

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = { flags: {}, args: [], rest: [] };
  let afterDashDash = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (afterDashDash) {
      parsed.rest.push(argument);
      continue;
    }
    if (argument === "--") {
      afterDashDash = true;
      continue;
    }
    if (argument === "-h") {
      parsed.flags.help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      parsed.args.push(argument);
      continue;
    }

    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) addFlag(parsed.flags, key, true);
    else {
      addFlag(parsed.flags, key, next);
      index++;
    }
  }
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
