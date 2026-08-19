import type { InferResponseType } from "hono/client";
import { Check, CircleAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import i18n from "../../i18n";
import { api, mutate } from "../../shared/api";
import { cn } from "../../ui/cn";
import { Head, Input, Meta } from "../../ui/bits";
import { Button } from "../../ui/button";
import { ask } from "../../ui/confirm";
import { Field, FieldContent, FieldGroup, FieldLabel, InputGroup } from "../../ui/field";
import { Tip } from "../../ui/tooltip";
import { ImageRow } from "../project/view";
import type { AuthRow, HostCheck } from "./auth";

/** Can this machine build a sandbox at all. Four facts, one line each. */
export function EnvPane({ checks }: { checks: HostCheck[] }) {
  const { t } = useTranslation();
  return (
    <>
      <Head title={t("settings.environment.title")} note={t("settings.environment.note")} />
      {!checks.length && <Meta className="block py-2">{t("settings.loading")}</Meta>}
      {/* One idiom for row rules across the dialog: the list draws them, not the
          rows, so there is no `first:` exception to forget. */}
      <div className="divide-y divide-rule-soft">
        {checks.map((c) => (
          <EnvironmentCheck key={c.name} check={c} />
        ))}
      </div>
    </>
  );
}

function EnvironmentCheck({ check }: { check: HostCheck }) {
  return (
    <div className="py-2">
      <div className="flex items-baseline gap-2">
        <CheckIcon ok={check.ok} />
        <span className={cn("text-[0.8125rem]", !check.ok && "text-accent")}>{check.name}</span>
        <Meta className="min-w-0 truncate">{check.detail}</Meta>
      </div>
      <CheckFix check={check} />
    </div>
  );
}

function CheckIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <Check size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-ok" />
  ) : (
    <CircleAlert size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-accent" />
  );
}

function CheckFix({ check }: { check: HostCheck }) {
  // Only the broken one gets the room: the command that fixes it.
  if (check.ok || !check.fix) return null;
  return (
    <span className="mt-1 ml-5 block rounded-md bg-sunk px-2 py-1 font-mono text-[0.6875rem] leading-relaxed text-ink-2">
      {check.fix}
    </span>
  );
}

export const ServerInfoSchema: z.ZodType<InferResponseType<(typeof api)["sandbox-server"]["$get"], 200>> = z.object({
  running: z.boolean(),
  addr: z.string(),
  inClear: z.boolean(),
  state: z.enum(["ours", "theirs", "stuck", "started", "down"]),
  why: z.string().nullable(),
  pid: z.string().nullable(),
  config: z.string().nullable(),
  argv: z.array(z.string()),
  restartable: z.boolean(),
  drift: z.object({ want: z.array(z.string()), config: z.string() }).nullable(),
  log: z.string(),
  containers: z.number(),
  runningTurns: z.number(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

/**
 * One line each, because the difference between them is what to do next.
 *
 * A function rather than a static record: the label has to come from whichever
 * locale is live right now, not whichever one was live when this module first
 * loaded.
 */
const SERVER_STATE_OK: Record<ServerInfo["state"], boolean> = {
  ours: true,
  started: true,
  theirs: true,
  stuck: false,
  down: false,
};
const serverState = (state: ServerInfo["state"]): { label: string; ok: boolean } => ({
  label: i18n.t(`settings.environment.state.${state}`),
  ok: SERVER_STATE_OK[state],
});

/**
 * Is the container server up, is its config still right, and how we reach it.
 *
 * One component rather than two, so changing the key re-asks the status by calling
 * a function instead of threading a counter across a visible seam. Ordered as the
 * eye needs it: which of five states this is and the one button for it, then why,
 * then the thing that fails silently, then the two plain settings.
 */
/**
 * `allowed_host_paths` is the most valuable thing here and is not a control: when
 * the allowlist stops covering the staged skills directory nothing fails loudly —
 * every container mounts an empty directory and the agents lack the skills the boss
 * ticked. Preflight builds the line to paste, so it is selectable rather than
 * described.
 *
 * The key is read from the server's own config, server-side, and never reaches the
 * browser: a key made up here is one the server has never heard of.
 */
export function ServerPane(props: {
  current?: AuthRow;
  checks: HostCheck[];
  server: ServerInfo | null;
  image: string;
  onRefreshServer: () => void;
  onRefreshImages: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Head title={t("settings.environment.serverTitle")} note={t("settings.environment.serverNote")} />
      <ServerStatus server={props.server} onRefresh={props.onRefreshServer} />
      {/* Silent when wrong, so it is loud here: a path missing from the
          allowlist mounts an empty directory rather than failing. */}
      <ServerDrift server={props.server} checks={props.checks} />
      <ServerFields {...props} />
    </>
  );
}

function ServerStatus({ server, onRefresh }: { server: ServerInfo | null; onRefresh: () => void }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <StatusSummary server={server} />
        <span className="grow" />
        {/* One control per state, and the two we must not offer are the point.
            A server we did not start is not ours to restart: killing it takes
            down whatever else on this machine was using it, and "we cannot
            drive it" is not evidence that nobody can. */}
        <ServerControl server={server} onRefresh={onRefresh} />
      </div>
      <ServerDetails server={server} />
    </>
  );
}

function StatusSummary({ server }: { server: ServerInfo | null }) {
  const { t } = useTranslation();
  if (!server) return <Meta>{t("settings.loading")}</Meta>;
  const state = serverState(server.state);
  return (
    <>
      {state.ok ? (
        <Check size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-ok" />
      ) : (
        <CircleAlert size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-accent" />
      )}
      <span className={cn("text-[0.8125rem]", !state.ok && "text-accent")}>{state.label}</span>
    </>
  );
}

function serverIdentity(server: ServerInfo) {
  return [server.pid && server.pid !== "?" ? `pid ${server.pid}` : null, server.config].filter(Boolean).join(" · ");
}

function ServerDetails({ server }: { server: ServerInfo | null }) {
  if (!server) return null;
  // Two identifiers for one process, on one line. They were a Meta beside the
  // status and a Meta three rows below it, and neither is a fact you read on the
  // way to something else.
  const ident = serverIdentity(server);
  return (
    <>
      <ServerWhy why={server.why} state={serverState(server.state).label} />
      <ServerIdentity value={ident} />
      <ServerLog log={server.log} />
    </>
  );
}

function ServerWhy({ why, state }: { why: string | null; state: string }) {
  // Under the line it explains, indented past the icon, and only when it adds
  // something — `没在跑` was rendering twice, once as the status and once as
  // its own reason, which reads as a stuck panel. It was a bordered box on
  // `sunk` too: a frame around one sentence, on the surface reserved for what a
  // machine produced.
  if (!why || why === state) return null;
  return <p className="mt-1 ml-5 text-[0.75rem] leading-relaxed text-ink-2">{why}</p>;
}

function ServerIdentity({ value }: { value: string }) {
  if (!value) return null;
  return <Meta className="mt-1 ml-5 block truncate">{value}</Meta>;
}

function ServerLog({ log }: { log: string }) {
  if (!log) return null;
  return (
    <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-sunk px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-ink-2">
      {log}
    </pre>
  );
}

function ServerControl({ server, onRefresh }: { server: ServerInfo | null; onRefresh: () => void }) {
  const { t } = useTranslation();
  if (!server) return null;
  if (server.state === "down") return <StartButton onRefresh={onRefresh} />;
  if (server.restartable) return <RestartButton server={server} onRefresh={onRefresh} />;
  return (
    <Tip label={t("settings.environment.restartTip")}>
      <Button size="sm" disabled>
        {t("settings.environment.restart")}
      </Button>
    </Tip>
  );
}

function StartButton({ onRefresh }: { onRefresh: () => void }) {
  const { t } = useTranslation();
  // The re-read is inside the pending window now. Clearing the flag before
  // `onRefresh()` let the button go live again while the line beside it still
  // said what it said before the server was started.
  const [busy, startTransition] = useTransition();
  const start = () =>
    startTransition(async () => {
      const response = await mutate(api["sandbox-server"].start.$post());
      onRefresh();
      if (response.ok) toast.success(t("settings.environment.startedToast"));
    });
  return (
    <Button size="sm" variant="go" disabled={busy} onClick={start}>
      {busy ? t("settings.environment.starting") : t("settings.environment.start")}
    </Button>
  );
}

function RestartButton({ server, onRefresh }: { server: ServerInfo; onRefresh: () => void }) {
  const { t } = useTranslation();
  const [busy, startTransition] = useTransition();
  const restart = async () => {
    const yes = await ask({
      title: t("settings.environment.restartConfirmTitle"),
      // The evidence beside the button: this is not a service bounce, it is
      // every container going away and every turn inside them dying with it.
      body: t("settings.environment.restartConfirmBody", {
        containers: server.containers,
        turns: server.runningTurns,
      }),
      yes: t("settings.environment.restartConfirmYes"),
      danger: true,
    });
    if (!yes) return;
    // The confirm is deliberately outside: nothing is in flight while the boss
    // is reading the dialog, and a button that goes pending on being asked a
    // question has already answered it.
    startTransition(async () => {
      const response = await mutate(api["sandbox-server"].restart.$post());
      onRefresh();
      if (response.ok) toast.success(t("settings.environment.restartedToast"));
    });
  };
  return (
    <Button size="sm" disabled={busy} onClick={restart}>
      {busy ? t("settings.environment.restarting") : t("settings.environment.restart")}
    </Button>
  );
}

function ServerDrift({ server, checks }: { server: ServerInfo | null; checks: HostCheck[] }) {
  const { t } = useTranslation();
  const drift = server ? server.drift : null;
  return drift ? (
    <DriftNotice detail={t("settings.environment.driftDetail")} fix={allowedPathsLine(drift.want)} />
  ) : (
    <PathNotice checks={checks} />
  );
}

function allowedPathsLine(paths: string[]) {
  return `allowed_host_paths = [${paths.map((path) => `"${path}"`).join(", ")}]`;
}

function PathNotice({ checks }: { checks: HostCheck[] }) {
  const paths = checks.find((check) => check.name === "allowed_host_paths");
  if (!paths || paths.ok) return null;
  const fix = paths.fix ? paths.fix.split("\n").slice(-1)[0]!.trim() : "";
  return <DriftNotice detail={paths.detail} fix={fix} />;
}

function DriftNotice({ detail, fix }: { detail: string; fix: string }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2.5 rounded-md bg-sunk px-3 py-2">
      <div className="text-[0.8125rem] text-accent">{detail}</div>
      <p className="mt-1 text-[0.75rem] text-ink-3">{t("settings.environment.driftHint")}</p>
      <pre className="mt-1.5 overflow-x-auto font-mono text-[0.6875rem] leading-relaxed text-ink-2 select-all">
        {fix}
      </pre>
    </div>
  );
}

type ServerPaneProps = Parameters<typeof ServerPane>[0];
type AuthJson = NonNullable<Parameters<typeof api.auth.$post>[0]>["json"];

function ServerFields(props: ServerPaneProps) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [busy, startTransition] = useTransition();

  /**
   * Adopt, replace or clear, and then ask the server again.
   *
   * The re-ask is the point of the merge: whether we can drive the server is a
   * function of the key, and clearing the key while the line above still reads
   * 在跑，直接用 is the shape this project keeps paying for — a stale answer that
   * looks like a healthy one.
   */
  const sendKey = (json: AuthJson) =>
    startTransition(async () => {
      const response = await mutate(api.auth.$post({ json }));
      // Only on success. A rejected key wiped from the box makes the fix "paste it
      // again", which is never the fix.
      if (response.ok) setKey("");
      props.onRefreshServer();
      props.onSaved();
    });

  const saveImage = (image: string) =>
    startTransition(async () => {
      const response = await mutate(api.sandbox.images.$post({ json: { image } }));
      if (!response.ok) return;
      // Re-read rather than assume: what the row shows is the server's
      // answer, and a write that was accepted is not a write that stored
      // this exact string.
      props.onRefreshImages();
      toast.success(
        image ? t("settings.environment.imageSavedToast", { image }) : t("settings.environment.resetToast"),
      );
    });

  return (
    // The status band above is one section, these two values are another, and
    // the gap is what says so.
    <FieldGroup className="mt-6">
      <AddressRow server={props.server} onRefresh={props.onRefreshServer} />
      {/* One default for the machine, so registering a repository needs no
          answer here at all: a new project sets no image and gets this one,
          the same way it gets the remote's default branch without being
          asked. The per-project row overrides it and is usually left alone. */}
      <ImageRow
        label={t("settings.environment.defaultImageLabel")}
        value={props.image}
        busy={busy}
        placeholder={t("settings.environment.defaultImagePlaceholder")}
        onSave={saveImage}
      />
      <KeyRow
        {...(props.current ? { current: props.current } : {})}
        value={key}
        busy={busy}
        onChange={setKey}
        onSend={sendKey}
      />
      {/* No "now put this in the server's config" line: that instruction is what
          got followed halfway, and a key only this side knows locks the fleet out
          of every container. 存下 refuses a key the server rejects. */}
    </FieldGroup>
  );
}

function AddressRow({ server, onRefresh }: { server: ServerInfo | null; onRefresh: () => void }) {
  const { t } = useTranslation();
  return (
    // The other way out of "that one is not ours", and the reason this is a
    // control rather than a yaml key: the fix for a taken port is a
    // different port, and an edit-and-restart is not a fix you make while
    // reading this.
    <Field>
      <FieldLabel htmlFor="sb-addr">{t("settings.environment.addrLabel")}</FieldLabel>
      {/* A column, because the warning under the box is a third child and a
          two-column grid put it in the label gutter. */}
      <FieldContent className="flex-col items-stretch gap-1">
        <Input
          id="sb-addr"
          className="font-mono"
          placeholder={t("settings.environment.addrPlaceholder")}
          defaultValue={server ? server.addr : ""}
          onKeyDown={async (event) => {
            if (event.key !== "Enter") return;
            const addr = event.currentTarget.value;
            const response = await mutate(api["sandbox-server"].addr.$post({ json: { addr } }));
            onRefresh();
            if (response.ok) {
              toast.success(
                addr.trim()
                  ? t("settings.environment.addrSavedToast", { addr: addr.trim() })
                  : t("settings.environment.resetToast"),
              );
            }
          }}
        />
        {/* The server does not have to be on this machine — a Tailscale peer
            or a cloud box works. Over WireGuard plain HTTP is fine, which is
            why this warns rather than refuses: on the open internet the
            api_key and every container payload cross it in the clear. */}
        {server?.inClear && (
          <span className="text-[0.75rem] text-accent">{t("settings.environment.addrClearWarning")}</span>
        )}
      </FieldContent>
    </Field>
  );
}

function keyPlaceholder(current?: AuthRow) {
  return current
    ? i18n.t("settings.environment.keyPlaceholderCurrent", { hint: current.hint })
    : i18n.t("settings.environment.keyPlaceholderEmpty");
}

function KeyRow({
  current,
  value,
  busy,
  onChange,
  onSend,
}: {
  current?: AuthRow;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSend: (json: AuthJson) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field>
      <FieldLabel htmlFor="sandbox-key">{t("settings.environment.keyLabel")}</FieldLabel>
      <InputGroup>
        <Input
          id="sandbox-key"
          className="min-w-0 flex-1 font-mono"
          // What is stored, in the box that stores it — same as the accounts.
          placeholder={keyPlaceholder(current)}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {/* The server owns this value, so it is read rather than invented. */}
        <Tip label={t("settings.environment.readFromServerTip")}>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onSend({ runtime: "sandbox", mode: "api_key", adopt: true })}
          >
            {t("settings.environment.readFromServer")}
          </Button>
        </Tip>
        <ClearKeyButton {...(current ? { current } : {})} busy={busy} onSend={onSend} />
        <SaveKeyButton value={value} busy={busy} onSend={onSend} />
      </InputGroup>
    </Field>
  );
}

function ClearKeyButton({
  current,
  busy,
  onSend,
}: {
  current?: AuthRow;
  busy: boolean;
  onSend: (json: AuthJson) => void;
}) {
  const { t } = useTranslation();
  // A key nobody told the server about locks the whole fleet out, and until
  // this button existed there was no way back from the panel that put it there.
  if (!current) return null;
  return (
    <Button size="sm" variant="quiet" disabled={busy} onClick={() => onSend({ runtime: "sandbox", clear: true })}>
      {t("settings.environment.clear")}
    </Button>
  );
}

function SaveKeyButton({ value, busy, onSend }: { value: string; busy: boolean; onSend: (json: AuthJson) => void }) {
  const { t } = useTranslation();
  const key = value.trim();
  // Only once there is something to save, same as every other field in this
  // dialog. A button that is always there and usually does nothing trains you
  // to ignore it.
  if (!key) return null;
  return (
    <Button
      variant="go"
      size="sm"
      disabled={busy}
      onClick={() => onSend({ runtime: "sandbox", mode: "api_key", secret: key })}
    >
      {t("settings.environment.save")}
    </Button>
  );
}
