import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setIn } from "../src/mech/sandbox/server.ts";
import { isServerLine, keyInConfig, SANDBOX_API_KEY_HEADER } from "../src/mech/sandbox/sandbox.ts";

/**
 * Starting the container server, and the four ways the first attempt lied.
 *
 * Every check here is one measured failure. The shared shape is that none of
 * them threw: a config was written that the server rejected, a key was sent in a
 * header nothing reads, and a shell was mistaken for a server — each reported as
 * "cannot connect", which was true and named none of them.
 */

// The example `opensandbox-server init-config` actually renders, trimmed to the
// parts that matter. `mode` appears in two sections and `api_key` ships
// commented out; both are load-bearing here.
const EXAMPLE = `[server]
host = "0.0.0.0"
port = 8080
# api_key = "your-secret-api-key"
# If api_key stays empty, startup requires explicit acknowledgment.

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.21"

[storage]
# Example: allowed_host_paths = ["/data/opensandbox", "/tmp/sandbox"]
volume_default_size = "1Gi"

[ingress]
mode = "direct"

[egress]
image = "opensandbox/egress:v1.1.4"
mode = "direct"
`;

test("a key is set in its own section, not in whichever section came first", () => {
  // The one that stopped the server booting. A file-wide `^mode =` replaced
  // `[ingress] mode` with `dns+nft`, and the server refused to start:
  //   Input should be 'direct' or 'gateway'
  // `mode` exists twice, and a match that does not know about sections finds
  // the wrong one every time.
  let toml = setIn(EXAMPLE, "egress", "mode", `mode = "dns+nft"`);
  toml = setIn(toml, "egress", "image", `image = "opensandbox/egress:v1.1.6"`);

  expect(toml).toContain(`[ingress]\nmode = "direct"`);
  expect(toml).toContain(`image = "opensandbox/egress:v1.1.6"`);
  expect(toml).toContain(`[egress]\nimage = "opensandbox/egress:v1.1.6"\nmode = "dns+nft"`);
  // v1.1.4 403s every scoped package fetch while a credential is bound (005),
  // and the example ships it.
  expect(toml).not.toContain("v1.1.4");
});

test("a commented-out key is the key, not a missing one", () => {
  // `# api_key = "your-secret-api-key"` read as absent left the server with no
  // key at all while we sent one — 401 on every call, reported as "the server
  // does not accept our key", which is exactly backwards.
  const toml = setIn(EXAMPLE, "server", "api_key", `api_key = "orch-abc"`);
  const f = join(mkdtempSync(join(tmpdir(), "orch-toml-")), "sandbox.toml");
  writeFileSync(f, toml);
  expect(keyInConfig(f)).toBe("orch-abc");
  // Replaced in place, not appended beside the commented one. Counting
  // assignment lines, not the word: the example also mentions `api_key` in a
  // sentence, and that line is prose.
  expect(toml.split("\n").filter((l) => /^[ \t]*#?[ \t]*api_key[ \t]*=/.test(l))).toEqual([
    `api_key = "orch-abc"`,
  ]);
});

test("a key with no line anywhere is added, and a missing section is created", () => {
  // `allowed_host_paths` is only ever present as a comment in the example, and
  // it is the silent one: a path missing from it does not fail, it mounts an
  // empty directory, and every agent quietly has no skills.
  const toml = setIn(EXAMPLE, "storage", "allowed_host_paths", `allowed_host_paths = ["/a", "/b"]`);
  expect(toml).toContain(`[storage]\nallowed_host_paths = ["/a", "/b"]`);
  // Untouched neighbours stay in their own section.
  expect(toml).toContain(`volume_default_size = "1Gi"`);

  const made = setIn(EXAMPLE, "nowhere", "k", `k = 1`);
  expect(made).toContain(`[nowhere]\nk = 1`);
});

test("the key travels in the one header the server reads", () => {
  // `Authorization: Bearer` is indistinguishable from a wrong key — 401 either
  // way — and the message then says the key was rejected when it was never
  // presented. The server reads this header and nothing else
  // (`middleware/auth.py`), so it has one home and both probes import it.
  expect(SANDBOX_API_KEY_HEADER).toBe("OPEN-SANDBOX-API-KEY");
  const src = ["src/mech/sandbox/server.ts", "src/mech/ops/preflight.ts"];
  for (const f of src) {
    const text = readFileSync(f, "utf8");
    // Nobody re-spells it, and nobody reaches for Bearer against this server.
    expect(text).not.toMatch(/"OPEN-SANDBOX-API-KEY"/);
    expect(text).toContain("SANDBOX_API_KEY_HEADER");
  }
});

test("a process talking about the server is not the server", () => {
  // The one that made autostart never fire. `runningServer` matched any command
  // line containing the name, so one `pkill -f opensandbox-server` in a shell —
  // ours, during this very debugging — was read as a live server, and the caller
  // reported "already running" on a machine with none.
  //
  // Worse than a false negative: the port was free, nothing was started, and the
  // panel said it was up.
  for (const real of [
    "12345 /opt/homebrew/bin/uv tool uvx opensandbox-server --config /Users/x/.orch-cache/sandbox.toml",
    "999 /usr/local/bin/opensandbox-server",
    "42 opensandbox-server --config ./sandbox.toml",
  ]) {
    expect({ line: real.slice(0, 40), server: isServerLine(real) }).toEqual({
      line: real.slice(0, 40),
      server: true,
    });
  }

  for (const impostor of [
    "6774 /bin/zsh -c pkill -f opensandbox-server; sleep 3",
    "6780 grep opensandbox-server",
    "77 ps -Ao pid=,args=",
    "88 tail -f /tmp/opensandbox-server.log",
    "99 vim src/mech/sandbox/server.ts opensandbox-server",
    "100 echo starting opensandbox-server",
  ]) {
    expect({ line: impostor.slice(0, 40), server: isServerLine(impostor) }).toEqual({
      line: impostor.slice(0, 40),
      server: false,
    });
  }

  // And the whole point of the fix above it: `ps` is never allowed to be the
  // reason we skip starting one. The port is the fact.
  const src = readFileSync("src/mech/sandbox/server.ts", "utf8");
  const down = src.slice(src.indexOf("// Nothing answers."), src.indexOf("export async function ensureServer"));
  expect(down).toContain('kind: "down"');
});
