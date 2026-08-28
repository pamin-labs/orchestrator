import { expect, test } from "bun:test";
import { parseJsonc, stripJsonc } from "../../src/mech/util/jsonc.ts";

/**
 * The file this exists for is `devcontainer.json`, and the templates that ship
 * it are commented — which is why `JSON.parse` alone reads nothing from the one
 * source that states a whole environment.
 */
test("comments and trailing commas go, and the JSON underneath survives", () => {
  expect(
    parseJsonc(`{
  // the image this project develops in
  "image": "mcr.microsoft.com/devcontainers/go:1.22",
  /* features are toolchains, in a registry
     that spans several lines */
  "features": { "ghcr.io/devcontainers/features/go:1": { "version": "1.22" } },
  "postCreateCommand": "go mod download",
}`),
  ).toEqual({
    image: "mcr.microsoft.com/devcontainers/go:1.22",
    features: { "ghcr.io/devcontainers/features/go:1": { version: "1.22" } },
    postCreateCommand: "go mod download",
  });
});

/**
 * The defect a regex version has on the first real file it meets: every feature
 * id and every image is a URL, and a URL contains `//`.
 */
test("a slash inside a string is not a comment", () => {
  expect(parseJsonc('{"image": "ghcr.io/devcontainers/features/go:1"}')).toEqual({
    image: "ghcr.io/devcontainers/features/go:1",
  });
  // An escaped quote does not end the string, and the escape moves with it.
  expect(parseJsonc('{"a": "say \\"//\\" here", "b": 1}')).toEqual({ a: 'say "//" here', b: 1 });
  // A comma inside a string is not a trailing comma.
  expect(parseJsonc('{"a": "x,}", "b": [1, 2,]}')).toEqual({ a: "x,}", b: [1, 2] });
});

test("what it cannot read, it declines to guess at", () => {
  expect(parseJsonc("{ not json at all")).toBeNull();
  expect(parseJsonc("")).toBeNull();
  // An unterminated block comment eats the rest, which is what a reader does.
  expect(stripJsonc('{"a":1} /* and then')).toBe('{"a":1} ');
});
