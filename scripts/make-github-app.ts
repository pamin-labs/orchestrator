/**
 * Register the GitHub App, from the boss's own browser, once.
 *
 * The alternative was driving a headless browser, which would have meant a GitHub
 * password and a 2FA code typed into a browser this process controls. GitHub's App
 * Manifest flow exists for exactly this: we describe the app, the boss clicks Create
 * in the session they are already logged into, and GitHub hands back the
 * identifiers. No credential ever passes through here.
 */
/**
 *   bun run scripts/make-github-app.ts [name] [--org <login>]
 *
 * What it cannot do, and says so at the end: two switches are not expressible in a
 * manifest and have to be ticked by hand afterwards. Both fail in ways that look
 * like something else, which is why they are printed rather than assumed.
 */
import { z } from "zod";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = 47822;
const HOME = "https://github.com/Pamin-Labs/orchestrator";

const argv = process.argv.slice(2);
const orgAt = argv.indexOf("--org");
const org = orgAt >= 0 ? argv[orgAt + 1] : null;
const name = argv.find((a) => !a.startsWith("--") && a !== org) ?? "orchestrator";

// `redirect_url` points back here, so the code arrives without a paste. The
// browser makes that request, not GitHub, which is why 127.0.0.1 works.
const manifest = {
  name,
  url: HOME,
  redirect_url: `http://127.0.0.1:${PORT}/done`,
  // Device flow needs no callback, but an app with none cannot be authorized at
  // all if the flow is ever switched.
  callback_urls: [`http://127.0.0.1:${PORT}/done`],
  // No webhooks: the orchestrator polls, and an endpoint nothing listens on is a
  // retry queue on GitHub's side for the life of the app.
  hook_attributes: { url: `${HOME}#unused`, active: false },
  // Private: this is one boss's own tool, not something to list publicly.
  public: false,
  default_permissions: {
    contents: "write",
    pull_requests: "write",
    metadata: "read",
  },
  default_events: [],
};

const where = org
  ? `https://github.com/organizations/${org}/settings/apps/new`
  : "https://github.com/settings/apps/new";

/**
 * English, like every other setup script: this runs once from a terminal, has no
 * `config.language` to read and no catalogue loaded, and it is the third row of
 * ADR 035's table — the same place `/readyz` and the console sit.
 */
const page = `<!doctype html><meta charset="utf-8"><title>Create a GitHub App</title>
<body style="font:15px/1.6 -apple-system,system-ui;max-width:34rem;margin:12vh auto;padding:0 1.5rem">
<h2 style="font-size:1.1rem">Create the GitHub App “${name}”</h2>
<p>The button below hands GitHub this app's description. The permissions are already filled in: Contents read/write, Pull requests read/write, Metadata read-only, and no webhook subscriptions. You can rename it on GitHub's own page.</p>
<form action="${where}" method="post">
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replaceAll("'", "&apos;")}'>
  <button type="submit" style="font:inherit;padding:.5rem 1rem;cursor:pointer">Create it on GitHub</button>
</form>
<p style="color:#666;font-size:.9rem">You land back here once it exists, and this page can be closed.</p>
</body>`;

const html = { "content-type": "text/html; charset=utf-8" };

let resolve: (code: string) => void;
const got = new Promise<string>((r) => {
  resolve = r;
});

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/done") {
      // Shape-checked here rather than at the `fetch` below, because this is the
      // one place a value from the socket enters the process. GitHub's conversion
      // code is an opaque token; anything with a `/`, a `?` or a `#` in it would
      // have steered the POST to a different `api.github.com` path, and the answer
      // to that call is written to disk as an app's private key.
      const code = u.searchParams.get("code");
      if (!code || !/^[\w-]+$/.test(code))
        return new Response("No code came back — start again.", { status: 400, headers: html });
      resolve(code);
      return new Response("<body style='font:15px -apple-system'>Done — back to the terminal.</body>", {
        headers: html,
      });
    }
    return new Response(page, { headers: html });
  },
});

const url = `http://127.0.0.1:${PORT}/`;
console.log(`\nOpen ${url} — paste it by hand if the browser does not come up\n`);
// Their Chrome, with their session. `open` falls back to the default browser.
// Not awaited on purpose — the server below is what this waits on, and a browser
// that never opens is a URL the reader pastes by hand. `void` says so out loud.
void Bun.spawn(["open", "-a", "Google Chrome", url], { stderr: "ignore" }).exited.then((code) => {
  if (code !== 0) Bun.spawn(["open", url], { stderr: "ignore" });
});

const code = await got;
// Awaited: `stop()` returns a promise, and the socket is still bound until it settles.
await server.stop();

// The code is single-use and short-lived: this is the only chance to read the
// private key, so it is written before anything else can fail.
// fallow-ignore-next-line security-sink -- fixed `https://api.github.com` origin, and `code` was shape-checked against `/^[\w-]+$/` at the socket, so it can only be one path segment.
const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
  method: "POST",
  headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
});
/**
 * GitHub's answer, parsed rather than asserted.
 *
 * It was `as { ... }`, which is a claim about a network response and not a check on
 * one — and `slug` from that response went straight into a file path. A slug
 * containing a separator escapes `data/` through `join`'s own normalisation, and
 * the file being written is a private key. CodeQL called it `js/http-to-file-access`.
 */
/**
 * The fix is to make the value incapable of being a path fragment rather than to
 * explain that GitHub would not send one. The character class is GitHub's own: an
 * App slug is lowercase alphanumerics and hyphens, and anything else fails loudly
 * before a key is written anywhere.
 */
const AppSchema = z.object({
  id: z.number(),
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, "GitHub returned an App slug that is not a slug"),
  client_id: z.string().min(1),
  pem: z.string().min(1),
  html_url: z.string().min(1),
  owner: z.object({ login: z.string() }),
});

const body: unknown = await res.json();
if (!res.ok) {
  // The status and GitHub's own message, not the body. A refused conversion
  // carries no key, but printing an unparsed response wholesale is how one
  // eventually will — and the message is the part a person can act on.
  const said = body !== null && typeof body === "object" && "message" in body ? String(body.message) : "";
  console.error(`GitHub refused the conversion: ${res.status} ${said}`);
  process.exit(1);
}
const parsed = AppSchema.safeParse(body);
if (!parsed.success) {
  console.error("GitHub's reply was not the expected shape; nothing was written:", parsed.error.issues);
  process.exit(1);
}
const app = parsed.data;

// The pem is a real secret and never goes in the repo. `data/` is gitignored and
// the server already chmods it 0700 at startup.
mkdirSync("data", { recursive: true });
const pem = join("data", `github-app-${app.slug}.pem`);
writeFileSync(pem, app.pem, { mode: 0o600 });
chmodSync(pem, 0o600);

// Every field below is a public identifier of the App that was just created:
// its URL, client id, slug, numeric id and owner login. The one secret in the
// response, `pem`, goes to a 0600 file and is referred to here only by path.
// Fallow flags them because they now trace to a parsed HTTP response, which is
// exactly what they are.
// fallow-ignore-next-line security-sink -- public identifiers of a just-created GitHub App; the private key is written to a 0600 file and only its path is printed. See the note above.
console.log(`
Created: ${app.html_url}

  client_id   ${app.client_id}
  slug        ${app.slug}
  app id      ${app.id}
  owner       ${app.owner.login}
  private key ${pem}   (0600, never in the repo)

client_id and slug are not secrets. Put them in config/default.yaml as
github.clientId / github.appSlug.

Two things a manifest cannot express, both of which fail as something else:

  1. Settings → Optional features → tick "Enable Device Flow"
     Without it the code request is refused outright and sign-in cannot start.

  2. Settings → Optional features → confirm "user-to-server token expiration" is OFF
     With it on, sign-in works today and the whole fleet 401s eight hours later —
     and refreshing needs a client secret we cannot ship.

  ${app.html_url}

Then Install App on the account or org that will run — authorising and installing
are two things, and only installing reaches the repositories.
`);
