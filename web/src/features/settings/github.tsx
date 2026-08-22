import { useTransition } from "react";
import { Badge } from "../../ui/badge";
import { H2, Head, Meta } from "../../ui/bits";
import { Button, LinkButton } from "../../ui/button";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle } from "../../ui/field";
import { Switch } from "../../ui/switch";
import { Tip } from "../../ui/tooltip";
import { api, mutate } from "../../shared/api";
import { DeviceCode } from "./auth";
import { z } from "zod";
import type { InferResponseType } from "hono/client";
import { Trans } from "@lingui/react/macro";
import { ph, t } from "@lingui/core/macro";

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
  return (
    <>
      {/* `Real tokens don't enter the sandbox` is already the note on `Model account`, and a sentence repeated on
          two panes stops being read on either. */}
      <Head title="GitHub" note={t`Code comes from here`} />
      <Connection status={s} onRefresh={onRefresh} />
      <Installations status={s} />
      {/* Under the connection because both answers come from it: the author is
          this login, and these are conventions of the repositories it reaches. */}
      <CommitSettings status={s} onSaved={onRefresh} />
    </>
  );
}

function Connection({ status, onRefresh }: { status: GhStatus | null; onRefresh: () => void }) {
  // One pending state for both directions, as before: connecting and
  // disconnecting are the same button row, and neither may be pressed while the
  // other is in flight. React 19 keeps `busy` true for the whole async function,
  // so the re-read that follows the write is inside the pending window rather
  // than after it — which is what a hand-cleared flag got wrong: the row went
  // live again while it was still showing the state from before the write.
  const [busy, start] = useTransition();

  const connect = () =>
    start(async () => {
      await mutate(api.auth.github.$post());
      onRefresh();
    });

  const disconnect = () =>
    start(async () => {
      await mutate(api.auth.$post({ json: { runtime: "github", clear: true } }));
      onRefresh();
    });

  return (
    <section>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <ConnectionStatus status={status} />
        <span className="grow" />
        <DisconnectButton status={status} busy={busy} onDisconnect={disconnect} />
        <ConnectButton status={status} busy={busy} onConnect={connect} />
      </div>
      {/* What the pane's own title and note already say — clone private repositories,
          push branches, open pull requests — is cut. What is left is the part that
          is not obvious. */}
      <Meta className="block">
        <Trans>One connection manages all projects</Trans>
      </Meta>
      <DeviceAuthorization status={status} />
      <ConnectionError status={status} />
    </section>
  );
}

function ConnectionStatus({ status }: { status: GhStatus | null }) {
  if (!status)
    return (
      <Meta>
        <Trans>Loading…</Trans>
      </Meta>
    );
  if (!status.connected)
    return (
      <span className="text-body font-medium text-accent">
        <Trans>Not connected</Trans>
      </span>
    );
  return <ConnectedStatus status={status} />;
}

function ConnectedStatus({ status }: { status: GhStatus }) {
  if (status.stale) {
    return (
      <span className="text-body font-medium text-accent">
        <Trans>Was connected, but GitHub no longer recognizes this token</Trans>
      </span>
    );
  }
  if (status.installed === false) {
    // Authorized and installed are different acts, and only the second one
    // can reach a repository. Saying `Connected` here would be a green tick over a
    // repo list that can never fill.
    const accountName = accountLabel(status.account, t`Authorized`);
    return (
      <span className="text-body font-medium text-accent">
        {t`${accountName}, but the App is not installed on any account yet`}
      </span>
    );
  }
  return <span className="text-body">{accountLabel(status.account, t`Connected`)}</span>;
}

function accountLabel(account: string | null, fallback: string) {
  return account ? `@${account}` : fallback;
}

function DisconnectButton({
  status,
  busy,
  onDisconnect,
}: {
  status: GhStatus | null;
  busy: boolean;
  onDisconnect: () => void;
}) {
  if (!status?.connected) return null;
  return (
    <Button size="sm" variant="quiet" disabled={busy} onClick={onDisconnect}>
      <Trans>Disconnect</Trans>
    </Button>
  );
}

function connectLabel(status: GhStatus, busy: boolean) {
  if (status.pending) return t`Waiting for you to approve on GitHub…`;
  if (busy) return t`Fetching login code…`;
  return status.stale ? t`Reconnect` : t`Connect GitHub`;
}

function canConnect(status: GhStatus) {
  return !status.connected || status.stale;
}

function connectDisabled(status: GhStatus, busy: boolean) {
  return busy || status.pending !== null;
}

function ConnectButton({ status, busy, onConnect }: { status: GhStatus | null; busy: boolean; onConnect: () => void }) {
  if (!status) return null;
  if (!canConnect(status)) return null;
  // A dead token is a stuck state, so the way out is on the row that says so —
  // not behind `Disconnect` first.
  return (
    <Button size="sm" disabled={connectDisabled(status, busy)} onClick={onConnect}>
      {connectLabel(status, busy)}
    </Button>
  );
}

function DeviceAuthorization({ status }: { status: GhStatus | null }) {
  if (!status) return null;
  if (!status.pending) return null;
  return (
    <DeviceCode
      code={status.pending.userCode}
      url={status.pending.verificationUri}
      go={t`Go to GitHub to enter code`}
    />
  );
}

function ConnectionError({ status }: { status: GhStatus | null }) {
  if (!status) return null;
  if (status.pending) return null;
  // Why it did not land, beside the button that tries again.
  if (!status.error) return null;
  return <p className="mt-1.5 text-secondary text-accent">{status.error}</p>;
}

function Installations({ status }: { status: GhStatus | null }) {
  if (!status) return null;
  if (!status.connected || status.stale) return null;
  return <InstallationSection status={status} />;
}

function InstallationSection({ status }: { status: GhStatus }) {
  return (
    // Which accounts this login can actually work in, and how much each one
    // can see. The boss asked "how do I install to several orgs" because the
    // panel could not show that this is a list at all.
    //
    // No rule above it: the heading and the gap are the boundary. A rule here
    // was the same token as the one inside the list below, so the section and
    // its rows were drawn with the same mark.
    <section className="mt-6">
      <div className="flex items-baseline gap-2">
        <H2>
          <Trans>Installed on these accounts</Trans>
        </H2>
        <span className="grow" />
        <InstallLink url={status.installUrl} />
      </div>
      <AccountList accounts={status.accounts} />
    </section>
  );
}

function InstallLink({ url }: { url: string }) {
  if (url) {
    return (
      <LinkButton href={url} className="px-2 py-0.5 text-secondary">
        <Trans>Install to another account</Trans>
      </LinkButton>
    );
  }
  return (
    <Tip label={t`Fill config/default.yaml with github.appSlug; this becomes a direct link.`}>
      <Meta>
        <Trans>GitHub → this App → Install App</Trans>
      </Meta>
    </Tip>
  );
}

type Installation = GhStatus["accounts"][number];

function AccountList({ accounts }: { accounts: Installation[] }) {
  if (!accounts.length) {
    return (
      <p className="text-secondary text-accent">
        <Trans>None; this connection sees no repositories. Install with all repos, or select specific ones.</Trans>
      </p>
    );
  }
  return (
    // Between the rows only. The enclosing pair made this the one list in the
    // dialog wearing a frame, which is the mark a section boundary is supposed
    // to be.
    <div className="divide-y divide-rule-soft">
      {accounts.map((account) => (
        <AccountRow key={account.id} account={account} />
      ))}
    </div>
  );
}

function AccountRow({ account }: { account: Installation }) {
  // Named by the binding rather than through `ph`: `${count}` extracts as
  // `{count}`, `${account.repos}` would be `{0}`.
  const { repos: count } = account;
  return (
    <div className="flex items-baseline gap-2 py-1.5">
      <span className="text-body">{account.account}</span>
      <Badge>{account.kind === "Organization" ? t`Organization` : t`Personal`}</Badge>
      <span className="grow" />
      {/* Tabular figures: `86` and `5` share a right edge either way,
          but proportional digits make the two counts look like two
          different scales. */}
      <Meta className="tabular-nums">{count === null ? t`Can't count` : t`${count} repositories`}</Meta>
    </div>
  );
}

function CommitSettings({ status, onSaved }: { status: GhStatus | null; onSaved: () => void }) {
  if (!status) return null;
  return <Commits s={status} onSaved={onSaved} />;
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
  const [busy, start] = useTransition();
  const set = (next: { signoff?: boolean; coauthor?: boolean }) =>
    start(async () => {
      await mutate(api.git.trailers.$post({ json: next }));
      onSaved();
    });
  const bot = s.identity.name === s.bot.name;
  return (
    <section className="mt-6">
      <H2>
        <Trans>Submit</Trans>
      </H2>
      <FieldGroup>
        {/* The author, stated rather than configured. It was a name in a yaml file
            that routed nowhere, so a `Signed-off-by` carrying it certified nothing
            and a reviewer clicking it got a 404.

            A row in the group rather than a sentence above it: it is the third
            fact about a commit, it shares the label column with the two switches,
            and the name stops being 11px mono Chinese prose with one word tinted
            darker. `role="group"` is already on `Field`; this names it. */}
        <Field aria-labelledby="t-author" className="items-center">
          <FieldTitle id="t-author">
            <Trans>Author</Trans>
          </FieldTitle>
          <FieldContent>
            <span className="font-mono text-secondary text-ink-2">{s.identity.name}</span>
            <Meta>
              {bot ? t`GitHub not connected yet; using our bot account for now` : t`From your connected GitHub account`}
            </Meta>
          </FieldContent>
        </Field>
        <Field className="items-center">
          <FieldLabel htmlFor="t-signoff">Sign-off</FieldLabel>
          <FieldContent>
            <Switch
              id="t-signoff"
              checked={s.trailers.signoff}
              disabled={busy}
              onCheckedChange={(v) => set({ signoff: v })}
            />
            <Meta>
              <Trans>Repos with DCO enabled won't accept commits without this line</Trans>
            </Meta>
          </FieldContent>
        </Field>
        <Field className="items-center">
          <FieldLabel htmlFor="t-coauthor">Co-author</FieldLabel>
          <FieldContent>
            <Switch
              id="t-coauthor"
              checked={s.trailers.coauthor}
              disabled={busy}
              onCheckedChange={(v) => set({ coauthor: v })}
            />
            <Meta>{t`Writes ${ph({ bot: s.bot.name })} into Co-Authored-By`}</Meta>
          </FieldContent>
        </Field>
      </FieldGroup>
    </section>
  );
}
