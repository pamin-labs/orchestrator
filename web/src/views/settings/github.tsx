import { useState } from "react";
import { Badge } from "../../ui/badge";
import { H2, Head, Meta } from "../../ui/bits";
import { Button, LinkButton } from "../../ui/button";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle } from "../../ui/field";
import { Switch } from "../../ui/switch";
import { Tip } from "../../ui/tooltip";
import { api, mutate } from "../../lib/api";
import { DeviceCode } from "./shared";
import { z } from "zod";
import type { InferResponseType } from "hono/client";

export const GhStatusSchema: z.ZodType<InferResponseType<typeof api.auth.github.$get, 200>> = z.object({
  connected: z.boolean(),
  account: z.string().nullable(),
  stale: z.boolean(),
  installed: z.boolean().nullable(),
  installUrl: z.string(),
  accounts: z.array(z.object({ id: z.number(), account: z.string(), kind: z.string(), repos: z.number().nullable() })),
  pending: z.object({ userCode: z.string(), verificationUri: z.string() }).nullable(),
  error: z.string().nullable(),
  trailers: z.object({ signoff: z.boolean(), coauthor: z.boolean(), claudeCoauthor: z.boolean() }),
  identity: z.object({ name: z.string(), email: z.string() }),
  bot: z.object({
    name: z.literal("orchestrator-agentic-app[bot]"),
    email: z.literal("317244264+orchestrator-agentic-app[bot]@users.noreply.github.com"),
  }),
});
export type GhStatus = z.infer<typeof GhStatusSchema>;

/**
 * Connect GitHub the way GitHub Desktop does: a code, a browser tab, nothing pasted.
 *
 * The code is the whole interaction, so it is the largest thing on the row and it
 * is one click away from the clipboard — a login code the boss has to hunt for in
 * a paragraph is a broken login. The button next to it opens the page it goes in,
 * because those two facts are useless apart.
 */
export function GithubPane({ status: s, onRefresh }: { status: GhStatus | null; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    await mutate(api.auth.github.$post());
    setBusy(false);
    onRefresh();
  };

  const pending = s?.pending;
  return (
    <>
      {/* 真令牌不进沙盒 is already the note on 模型账号, and a sentence repeated on
          two panes stops being read on either. */}
      <Head title="GitHub" note="代码从这儿来" />

      <section>
        <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {!s ? (
            <Meta>读取中…</Meta>
          ) : !s.connected ? (
            <span className="text-[0.8125rem] font-medium text-accent">没连</span>
          ) : s.stale ? (
            <span className="text-[0.8125rem] font-medium text-accent">连过，但 GitHub 现在不认这个令牌了</span>
          ) : s.installed === false ? (
            // Authorized and installed are different acts, and only the second one
            // can reach a repository. Saying 已连 here would be a green tick over a
            // repo list that can never fill.
            <span className="text-[0.8125rem] font-medium text-accent">
              {s.account ? `@${s.account} 授权了` : "授权了"}，但 App 还没装到任何账号上
            </span>
          ) : (
            <span className="text-[0.8125rem]">{s.account ? `@${s.account}` : "已连"}</span>
          )}
          <span className="grow" />
          {s?.connected && (
            <Button
              size="sm"
              variant="quiet"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await mutate(api.auth.$post({ json: { runtime: "github", clear: true } }));
                setBusy(false);
                onRefresh();
              }}
            >
              断开
            </Button>
          )}
          {/* A dead token is a stuck state, so the way out is on the row that says
              so — not behind 断开 first. */}
          {s && (!s.connected || s.stale) && (
            <Button size="sm" disabled={busy || !!pending} onClick={connect}>
              {pending ? "等你在 GitHub 上批准…" : busy ? "去拿登录码…" : s.stale ? "重新连接" : "连接 GitHub"}
            </Button>
          )}
        </div>
        {/* What the pane's own title and note already say — 克隆私有仓库、推分支、
            开 PR — is cut. What is left is the part that is not obvious. */}
        <Meta className="block">一个连接管所有项目</Meta>

        {pending && <DeviceCode code={pending.userCode} url={pending.verificationUri} go="去 GitHub 输入" />}

        {/* Why it did not land, beside the button that tries again. */}
        {!pending && s?.error && <p className="mt-1.5 text-[0.75rem] text-accent">{s.error}</p>}
      </section>

      {/* Which accounts this login can actually work in, and how much each one
          can see. The boss asked "how do I install to several orgs" because the
          panel could not show that this is a list at all.

          No rule above it: the heading and the gap are the boundary. A rule here
          was the same token as the one inside the list below, so the section and
          its rows were drawn with the same mark. */}
      {s?.connected && !s.stale && (
        <section className="mt-6">
          <div className="flex items-baseline gap-2">
            <H2>装在哪些账号上</H2>
            <span className="grow" />
            {s.installUrl ? (
              <LinkButton href={s.installUrl} className="px-2 py-0.5 text-[0.75rem]">
                装到别的账号
              </LinkButton>
            ) : (
              <Tip label="config/default.yaml 里填上 github.appSlug，这里就是个直达链接。">
                <Meta>去 GitHub → 这个 App → Install App</Meta>
              </Tip>
            )}
          </div>
          {!s.accounts.length ? (
            <p className="text-[0.75rem] text-accent">
              一个也没有，这个连接看不见任何仓库。装的时候选所有仓库，或者挑几个。
            </p>
          ) : (
            /* Between the rows only. The enclosing pair made this the one list in
               the dialog wearing a frame, which is the mark a section boundary is
               supposed to be. */
            <div className="divide-y divide-rule-soft">
              {s.accounts.map((a) => (
                <div key={a.id} className="flex items-baseline gap-2 py-1.5">
                  <span className="text-[0.8125rem]">{a.account}</span>
                  <Badge>{a.kind === "Organization" ? "组织" : "个人"}</Badge>
                  <span className="grow" />
                  {/* Tabular figures: `86` and `5` share a right edge either way,
                      but proportional digits make the two counts look like two
                      different scales. */}
                  <Meta className="tabular-nums">{a.repos === null ? "数不出来" : `${a.repos} 个仓库`}</Meta>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Under the connection because both answers come from it: the author is
          this login, and these are conventions of the repositories it reaches. */}
      {s && <Commits s={s} onSaved={onRefresh} />}
    </>
  );
}

/**
 * What every commit this system writes carries besides its message.
 *
 * Here rather than in the yaml: they are decisions about a repository's
 * conventions, and the person making them is looking at this page. Both default
 * on — a repository with DCO refuses an unsigned commit at the last step of a
 * finished branch, and a diff an agent wrote should say so in the record.
 */
function Commits({ s, onSaved }: { s: GhStatus; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const set = async (next: { signoff?: boolean; coauthor?: boolean }) => {
    setBusy(true);
    await mutate(api.git.trailers.$post({ json: next }));
    setBusy(false);
    onSaved();
  };
  const bot = s.identity.name === s.bot.name;
  return (
    <section className="mt-6">
      <H2>提交</H2>
      <FieldGroup>
        {/* The author, stated rather than configured. It was a name in a yaml file
            that routed nowhere, so a `Signed-off-by` carrying it certified nothing
            and a reviewer clicking it got a 404.

            A row in the group rather than a sentence above it: it is the third
            fact about a commit, it shares the label column with the two switches,
            and the name stops being 11px mono Chinese prose with one word tinted
            darker. `role="group"` is already on `Field`; this names it. */}
        <Field aria-labelledby="t-author" className="items-center">
          <FieldTitle id="t-author">作者</FieldTitle>
          <FieldContent>
            <span className="font-mono text-[0.75rem] text-ink-2">{s.identity.name}</span>
            <Meta>{bot ? "还没连 GitHub，先用我们的机器人账号" : "取自你连的 GitHub 账号"}</Meta>
          </FieldContent>
        </Field>
        <Field className="items-center">
          <FieldLabel htmlFor="t-signoff">Sign-off</FieldLabel>
          <FieldContent>
            <Switch
              id="t-signoff"
              checked={s.trailers.signoff}
              disabled={busy}
              onCheckedChange={(v) => void set({ signoff: v })}
            />
            <Meta>开了 DCO 的仓库不收没有这行的提交</Meta>
          </FieldContent>
        </Field>
        <Field className="items-center">
          <FieldLabel htmlFor="t-coauthor">Co-author</FieldLabel>
          <FieldContent>
            <Switch
              id="t-coauthor"
              checked={s.trailers.coauthor}
              disabled={busy}
              onCheckedChange={(v) => void set({ coauthor: v })}
            />
            <Meta>把 {s.bot.name} 写进 Co-Authored-By</Meta>
          </FieldContent>
        </Field>
      </FieldGroup>
    </section>
  );
}
