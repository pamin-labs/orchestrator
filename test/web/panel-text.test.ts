import { expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/contracts/panel.ts";
import { makeApp, UPLOAD_LIMIT } from "../../src/composition/api.ts";
import { imagePaths, withAttachments } from "../../src/mech/util/attachment-text.ts";
import { activityOf } from "../../web/src/lib/activity.ts";
import { splitAttachments } from "../../web/src/lib/attach.ts";
import { repoHref } from "../../web/src/lib/utils.ts";
import { testContext } from "../support/test-context.ts";
import { tempDir } from "../support/temp.ts";

const of = (activity: string) =>
  activityOf(
    Agent.parse({
      id: 1,
      grp_id: null,
      role: "engineer",
      model: "test",
      state: "running",
      activity,
      session_tokens: 0,
      total_tokens: 0,
      turns: 0,
      slice_id: null,
    }),
  );

const AttachResponse = z.object({
  files: z.array(z.object({ name: z.string(), path: z.string(), type: z.string(), size: z.number() })),
});

test("the wall says what a command is for, and keeps what it was for", () => {
  // Verbatim off the live wall. Every row was shell, so scanning it meant reading
  // every command in full to find the one agent that was not making progress.
  expect(of('command_execution: orch ctx query "S1 通用文件目录选择器"')).toEqual([
    "查索引",
    '"S1 通用文件目录选择器"',
  ]);
  expect(of("command_execution: bun test test/api.test.ts")).toEqual(["跑测试", "test/api.test.ts"]);
  expect(of("file_change: web/src/app.tsx")).toEqual(["改文件", "web/src/app.tsx"]);
  expect(of("Bash: git diff main...HEAD")).toEqual(["看改动", "main...HEAD"]);
});

test("an unrecognised command keeps its own words rather than being filed as 其他", () => {
  // A wrong category is worse than none: the boss would stop trusting the ones
  // that are right.
  expect(of("command_execution: ./scripts/deploy.sh --dry-run")).toEqual(["", "./scripts/deploy.sh --dry-run"]);
});

test("a message hands its attachments back as things the panel can open", () => {
  // Exactly what withAttachments() writes. The boss's screenshot used to render
  // as this line, under the question it was evidence for.
  const { text, files } = splitAttachments(
    "按 [图1] 改\n\n附件（路径如下）：\n- [图1] data/attachments/1755-0-Screenshot.png (image)\n- [附件2] data/attachments/1755-1-spec.pdf",
  );
  expect(text).toBe("按 [图1] 改");
  expect(files.map((f) => f.image)).toEqual([true, false]);
  expect(files.map((f) => f.label)).toEqual(["图1", "附件2"]);
  expect(files[0]!.url).toBe("/api/v1/attach/1755-0-Screenshot.png");
});

test("a message that merely mentions attachments keeps its own body", () => {
  const body = "附件（路径如下）：\n还没传呢";
  expect(splitAttachments(body).text).toBe(body);
  expect(splitAttachments("没有附件").files).toEqual([]);
});

test("labelled image paths still reach codex as -i flags", () => {
  // The label is written into the same line the image tag is on, and imagePaths
  // is how those files leave for a CLI with no tool that opens an image.
  const prompt = withAttachments("按 [图1] 改", [
    { name: "a.png", path: "/data/a.png", type: "image/png", label: "图1" },
    { name: "s.pdf", path: "/data/s.pdf", type: "application/pdf", label: "附件2" },
  ]);
  expect(prompt).toContain("- [图1] /data/a.png (image)");
  expect(imagePaths(prompt)).toEqual(["/data/a.png"]);
});

test("asking twice for the same prompt's images answers the same twice", () => {
  // The pattern is compiled once at module load and shared by every call. A `/g`
  // regex carries `lastIndex`, so a shared one that leaked it would answer the
  // first caller and hand the second an empty list — every turn after the first
  // in a process losing its `-i` flags, with nothing failing out loud.
  const prompt = withAttachments("改", [
    { name: "a.png", path: "/data/a.png", type: "image/png" },
    { name: "b.png", path: "/data/b.png", type: "image/png" },
  ]);
  expect(imagePaths(prompt)).toEqual(["/data/a.png", "/data/b.png"]);
  expect(imagePaths(prompt)).toEqual(["/data/a.png", "/data/b.png"]);
});

test("an upload too big to hold is refused before it is held", async () => {
  // `postAttach`'s 25MB check runs after `req.formData()` has already parsed the
  // whole body into memory, so it never bounded the request — and a dropped
  // folder is one gesture that sends forty files. `content-length` is what every
  // browser upload carries, so this is decided without reading a byte.
  const app = makeApp(testContext());
  const r = await app(
    new Request("http://x/api/v1/attach", {
      method: "POST",
      body: "x",
      headers: {
        "content-type": "multipart/form-data; boundary=b",
        "content-length": String(UPLOAD_LIMIT + 1),
        "idempotency-key": crypto.randomUUID(),
      },
    }),
  );
  expect(r.status).toBe(413);
  expect(await r.text()).toContain("MB");
});

test("a dropped folder becomes one attachment, and cannot escape its directory", async () => {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = tempDir("attach-");
  const form = new FormData();
  form.append("file", new File(["a"], "a.txt"), "a.txt");
  form.append("rel", "spec/a.txt");
  form.append("file", new File(["b"], "b.txt"), "b.txt");
  // Every segment is sanitised, so a crafted relative path lands inside.
  form.append("rel", "spec/../../../b.txt");
  form.append("file", new File(["c"], "c.png", { type: "image/png" }), "c.png");
  form.append("rel", "c.png");

  const ctx = testContext();
  ctx.config.dataDir = dir;
  const app = makeApp(ctx);
  const r = await app(
    new Request("http://x/api/v1/attach", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: form,
    }),
  );
  const { files } = AttachResponse.parse(await r.json());

  // The folder is one entry, the loose image is another. Forty files inside a
  // dropped folder would otherwise be forty things to refer to.
  expect(files.map((f) => f.type)).toEqual(["image/png", "inode/directory"]);
  const folder = files.find((f) => f.type === "inode/directory")!;
  expect(folder.name).toBe("spec");
  expect(existsSync(join(folder.path, "a.txt"))).toBe(true);
  expect(existsSync(join(folder.path, "b.txt"))).toBe(true);
  expect(existsSync(join(dir, "b.txt"))).toBe(false);
});

test("a project links to its repository, and a leftover path never becomes a link", () => {
  // `repo_path` is `owner/name` for every project — migration 037 converted the
  // host paths. The shape is still checked rather than assumed, because that
  // migration deliberately leaves a row it could not convert holding its old
  // path, and `https://github.com//Users/…` is worse than plain text.
  expect(repoHref("acme/site")).toBe("https://github.com/acme/site");
  expect(repoHref("Jason-Xu.dev/my_repo-2")).toBe("https://github.com/Jason-Xu.dev/my_repo-2");

  // A leading `/` is what every unconverted row still has.
  expect(repoHref("/Users/jason/Documents/GitHub/orchestrator")).toBeNull();
  expect(repoHref("/tmp/p")).toBeNull();
  expect(repoHref("")).toBeNull();
  expect(repoHref(null)).toBeNull();
});
