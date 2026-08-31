import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { makeApp } from "../../src/composition/api.ts";
import { titleFor, titlePrompt } from "../../src/api/panel/title.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { grp } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

const GroupIdResponse = z.object({ grp_id: z.number() });

/** A one-shot ask that answers whatever the test hands it. */
const answering = (reply: string | (() => Promise<string>)) => () => async () =>
  typeof reply === "string" ? reply : await reply();

test("the prompt asks for a branch name and a title, and names the language of the second", () => {
  const prompt = titlePrompt("我们要给登录加一个记住我", "zh");
  expect(prompt).toContain("我们要给登录加一个记住我");
  expect(prompt).toContain("in zh");
  // The branch line is the one that must not be translated: it becomes a path.
  expect(prompt).toContain("English");
});

test("the model writes both names, and every way it can fail lands on today's slug", async () => {
  const ctx = await testContext();
  const idea = "add a remember-me checkbox to the login form";

  ctx.askIn = answering("remember-me-checkbox\n登录表单加一个「记住我」勾选框");
  expect(await titleFor(ctx, 1, idea)).toEqual({
    name: "remember-me-checkbox",
    title: "登录表单加一个「记住我」勾选框",
  });

  // Whatever `slug` would have said, which is what this route did before.
  const before = { name: "remember-me-checkbox-login", title: null };

  // A tripped breaker answers "" rather than throwing.
  ctx.askIn = answering("");
  expect(await titleFor(ctx, 1, idea)).toEqual(before);

  ctx.askIn = answering(() => Promise.reject(new Error("the sandbox is gone")));
  expect(await titleFor(ctx, 1, idea)).toEqual(before);

  // No navigator configured at all: the field is optional on `Ctx`.
  const { askIn: _dropped, ...noNavigator } = ctx;
  expect(await titleFor(noNavigator, 1, idea)).toEqual(before);
});

test("a model that answers its title on the first line does not get a chinese branch name", async () => {
  const ctx = await testContext();
  // `slug`'s own fallback keeps `\p{L}`, so this line survives it intact — and
  // `name` becomes `orch/<name>`, a worktree path and a `docs/journal` path.
  ctx.askIn = answering("登录表单加一个记住我");
  const { name, title } = await titleFor(ctx, 1, "add a remember-me checkbox to the login form");
  expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  expect(title).toBeNull();
});

test("filing a ticket stores the written title beside the slug the branch is cut from", async () => {
  const db = await openMemory();
  const ctx: Ctx = await testContext({ db });
  ctx.askIn = answering("rate-limit-the-api\n给公开 API 加限流");
  const app = makeApp(ctx);
  const project = await fx.on(db).project.create({ name: "p", remote: "https://github.com/o/p.git" });

  const filed = await app(
    new Request("http://x/api/v1/ideas", {
      method: "POST",
      body: JSON.stringify({ project_id: project.id, text: "we keep getting hammered, put a limit on the api" }),
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    }),
  );
  expect(filed.status).toBe(200);
  const { grp_id } = GroupIdResponse.parse(await filed.json());

  const [row] = await db.select({ name: grp.name, title: grp.title }).from(grp).where(eq(grp.id, grp_id));
  expect(row).toEqual({ name: "rate-limit-the-api", title: "给公开 API 加限流" });
});
