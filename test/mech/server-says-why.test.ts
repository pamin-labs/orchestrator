import { expect, test } from "bun:test";
import { say, type Probe } from "../../src/mech/sandbox/server.ts";
import { renderSaid } from "../../src/platform/text/lang.ts";
import { said } from "../support/said.ts";

/**
 * The four things a sandbox server can be, said once each.
 *
 * This is the sentence under the Sandbox server pane's heading and the one the
 * console warns with, and every one of its branches ends in a control the boss
 * is meant to press — so what each case says is the whole point of the pane.
 * It had no test at all: four branches, `audit:crap` at exactly the threshold,
 * which is what CI said when the local `audit` did not.
 */
/**
 * Rendered rather than compared as descriptors, because a descriptor's id is a
 * hash of the English and asserting on one says nothing a reader can check.
 */
const en = (p: Probe) => renderSaid("en", say(p, "127.0.0.1:8080"));

test("a server that answers and refuses our key names the two ways out", () => {
  const text = en({ kind: "auth" });
  // The address, so the boss knows which server; and both exits, because this
  // is the case where the machine is doing exactly what it was told to.
  expect(text).toContain("127.0.0.1:8080");
  // `Read from server`, not "put the api_key in Settings", which is what this
  // asserted while the sentence also opened with "something is listening that we
  // did not start". Both halves were wrong in the case that actually happened:
  // our own server from an earlier run, holding the key we wrote, against a
  // database that had been rebuilt without the row. Nobody types that key —
  // `serverKeyOnDisk` reads it out of the running server's own `--config`.
  expect(text).toContain("Read from server");
  expect(text).toContain("another address");
  // The claim this branch cannot support: `inspectServer` reaches here on the
  // port alone and will not let `ps` speak to whose process it is.
  expect(text).not.toContain("we did not start");
});

test("something else on the port says what it answered with", () => {
  const text = en({ kind: "http", status: 502 });
  // The status is the evidence: 502 is a proxy in the way, 200 is a different
  // service. Without it the sentence is "it did not work".
  expect(text).toContain("502");
  expect(text).toContain("127.0.0.1:8080");
});

/**
 * `none` forwards a sentence somebody else wrote — the probe's own reason,
 * which is an exception text or one of `waitUp`'s messages. It is passed
 * through rather than wrapped, so a caller reads one sentence and not two.
 */
test("nothing on the port forwards the reason it was given", () => {
  expect(en({ kind: "none", why: said("connection refused") })).toBe("connection refused");
});

test("a healthy server says so in one word", () => {
  expect(en({ kind: "ok" })).toBe("reachable");
});
