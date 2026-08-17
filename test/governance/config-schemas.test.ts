import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { z } from "zod";
import addFormats from "ajv-formats";

/**
 * Configuration files nobody validates.
 *
 * `codecov.yml` and `.github/dependabot.yml` are read by services, not by this
 * repository, and both fail silently: Codecov ignores a file it cannot parse,
 * which quietly removes the coverage gate, and Dependabot simply stops opening
 * updates. Neither produces an error anyone sees. actionlint covers workflow
 * syntax and does not look at these.
 *
 * The schemas are the published ones from SchemaStore, vendored under
 * `test/fixtures/schemas/` so the suite never touches the network. Refresh with:
 *
 *   curl -sL https://json.schemastore.org/codecov.json \
 *     -o test/fixtures/schemas/codecov.json
 *   curl -sL https://json.schemastore.org/dependabot-2.0.json \
 *     -o test/fixtures/schemas/dependabot-2.0.json
 *
 * A schema update that starts rejecting our file is the signal to read the
 * changelog, not to edit the schema.
 */

/** Enough shape to know a schema file is a schema, without describing JSON Schema. */
const SchemaDocument = z.looseObject({ $schema: z.string() });

const schema = (name: string) =>
  SchemaDocument.parse(JSON.parse(readFileSync(`test/fixtures/schemas/${name}.json`, "utf8")));

/** Both vendored schemas are draft-07. A newer draft fails loudly here. */
function validator(name: string) {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  return ajv.compile(schema(name));
}

function check(name: string, path: string): void {
  const validate = validator(name);
  const document: unknown = Bun.YAML.parse(readFileSync(path, "utf8"));
  const ok = validate(document);
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("\n");
  expect(ok ? "" : `${path}\n${errors}`).toBe("");
}

test("codecov.yml is what Codecov will actually read", () => {
  check("codecov", "codecov.yml");
});

test("dependabot.yml is what Dependabot will actually read", () => {
  check("dependabot-2.0", ".github/dependabot.yml");
});

test("the vendored schemas reject a file the services would ignore", () => {
  // Proof the check has teeth. `coverage.status.patch` takes an object of
  // contexts; a bare string parses as YAML and would be dropped on Codecov's
  // side without a word.
  const validate = validator("codecov");
  expect(validate({ coverage: { status: { patch: "yes please" } } })).toBe(false);
  expect(validate({ coverage: { status: { patch: { default: { target: "65%" } } } } })).toBe(true);
});
