import { afterEach, expect, test } from "bun:test";
import { expandMacros } from "../../scripts/lingui-macros.ts";

/**
 * The expansion is the same under a production `NODE_ENV` as under none.
 *
 * Lingui's `descriptorFields` defaults to "auto": `{id, message}` in development
 * and `{id}` alone in production. English is loaded as `{}` on purpose — the
 * source the macro hashed *is* the fallback — so a build that dropped `message`
 * renders `cfg2rE` where the heading belongs.
 */
/**
 * It would also stay green. Nothing here sets `NODE_ENV`, so the day a
 * Dockerfile or a workflow adds one is the day the panel breaks.
 */
const SOURCE = `import { Trans } from "@lingui/react/macro";
export const X = () => <Trans>Event stream</Trans>;
`;

/** Distinct paths, because the content-addressed cache is keyed on the path too —
 *  reusing one would compare an entry against itself and prove nothing. */
const under = (env: string | undefined, path: string): string => {
  const had = process.env.NODE_ENV;
  if (env === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = env;
  try {
    return expandMacros(SOURCE, `${process.cwd()}/web/src/${path}`).code;
  } finally {
    if (had === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = had;
  }
};

afterEach(() => {
  // The macro plugin reads the variable per transform, so a leak would decide
  // the next file's output rather than failing here.
  expect(process.env.NODE_ENV).not.toBe("production");
});

test("a production NODE_ENV does not strip the source text out of the descriptor", () => {
  const dev = under(undefined, "__probe-dev.tsx");
  const prod = under("production", "__probe-prod.tsx");

  // The text has to survive, or there is nothing for English to fall back to.
  expect(dev).toContain('message: "Event stream"');
  expect(prod).toContain('message: "Event stream"');
  expect(prod).toBe(dev);
});
