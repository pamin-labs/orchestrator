/**
 * Register the GitHub App, from the boss's own browser, once.
 *
 * The alternative was driving a headless browser, which would have meant a
 * GitHub password and a 2FA code typed into a browser this process controls.
 * GitHub's App Manifest flow exists for exactly this: we describe the app, the
 * boss clicks Create in the session they are already logged into, and GitHub
 * hands back the identifiers. No credential ever passes through here.
 *
 *   bun run scripts/make-github-app.ts [name] [--org <login>]
 *
 * What it cannot do, and says so at the end: two switches are not expressible in
 * a manifest and have to be ticked by hand afterwards. Both fail in ways that
 * look like something else, which is why they are printed rather than assumed.
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

const page = `<!doctype html><meta charset="utf-8"><title>创建 GitHub App</title>
<body style="font:15px/1.6 -apple-system,system-ui;max-width:34rem;margin:12vh auto;padding:0 1.5rem">
<h2 style="font-size:1.1rem">创建 GitHub App「${name}」</h2>
<p>下面这个按钮把 app 的描述交给 GitHub。权限已经填好：Contents 读写、Pull requests 读写、Metadata 只读，不订阅任何 webhook。名字可以在 GitHub 的页面上改。</p>
<form action="${where}" method="post">
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replaceAll("'", "&apos;")}'>
  <button type="submit" style="font:inherit;padding:.5rem 1rem;cursor:pointer">去 GitHub 创建</button>
</form>
<p style="color:#666;font-size:.9rem">创建完会自动跳回这里，然后这个页面就可以关掉了。</p>
</body>`;

const html = { "content-type": "text/html; charset=utf-8" };

let resolve: (code: string) => void;
const got = new Promise<string>((r) => (resolve = r));

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
        return new Response("没有拿到 code，重来一次。", { status: 400, headers: html });
      resolve(code);
      return new Response("<body style='font:15px -apple-system'>好了，回终端看。</body>", { headers: html });
    }
    return new Response(page, { headers: html });
  },
});

const url = `http://127.0.0.1:${PORT}/`;
console.log(`\n打开 ${url} —— 浏览器起不来的话自己贴过去\n`);
// Their Chrome, with their session. `open` falls back to the default browser.
Bun.spawn(["open", "-a", "Google Chrome", url], { stderr: "ignore" }).exited.then((code) => {
  if (code !== 0) Bun.spawn(["open", url], { stderr: "ignore" });
});

const code = await got;
server.stop();

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
 * It was `as { ... }`, which is a claim about a network response and not a
 * check on one — and `slug` from that response went straight into a file path.
 * A slug containing a separator escapes `data/` through `join`'s own
 * normalisation, and the file being written is a private key. CodeQL called it
 * `js/http-to-file-access`; the fix is to make the value incapable of being a
 * path fragment rather than to explain that GitHub would not send one.
 *
 * The character class is GitHub's own: an App slug is lowercase alphanumerics
 * and hyphens. Anything else fails here, loudly, before a key is written
 * anywhere.
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
  console.error(`GitHub 拒绝了这次转换：${res.status} ${said}`);
  process.exit(1);
}
const parsed = AppSchema.safeParse(body);
if (!parsed.success) {
  console.error("GitHub 的回复不是预期的形状，没有写任何文件：", parsed.error.issues);
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
建好了：${app.html_url}

  client_id   ${app.client_id}
  slug        ${app.slug}
  app id      ${app.id}
  owner       ${app.owner.login}
  private key ${pem}   (0600，不进仓库)

client_id 和 slug 不是机密，填进 config/default.yaml 的 github.clientId / github.appSlug。

还有两件事只能手点，manifest 表达不了，而且两个都会以别的样子失败：

  1. Settings → Optional features → 勾上 "Enable Device Flow"
     不勾：取码那一步直接被拒，登录根本开不了头。

  2. Settings → Optional features → 确认 "user-to-server token expiration" 是关的
     开着：登录今天好用，八小时后全舰队 401，而刷新需要我们 ship 不了的 client secret。

  ${app.html_url}

然后 Install App，装到要跑的账号或 org 上 —— 授权和安装是两件事，只有装了才够得到仓库。
`);
