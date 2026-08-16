import { useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import { toast } from "sonner";
import { Head, Input, Meta } from "../../ui/bits";
import { Button } from "../../ui/button";
import { ask } from "../../ui/confirm";
import { Field, FieldContent, FieldGroup, FieldLabel, InputGroup } from "../../ui/field";
import { Tip } from "../../ui/tooltip";
import { post } from "../../lib/api";
import { cn } from "../../lib/utils";
import { ImageRow } from "../project";
import type { AuthRow, HostCheck } from "./shared";

/** Can this machine build a sandbox at all. Four facts, one line each. */
export function EnvPane({ checks }: { checks: HostCheck[] }) {
  return (
    <>
      <Head title="环境" note="沙盒要用的" />
      {!checks.length && <Meta className="block py-2">读取中…</Meta>}
      {/* One idiom for row rules across the dialog: the list draws them, not the
          rows, so there is no `first:` exception to forget. */}
      <div className="divide-y divide-rule-soft">
        {checks.map((c) => (
          <div key={c.name} className="py-2">
            <div className="flex items-baseline gap-2">
              {c.ok ? (
                <Check size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-ok" />
              ) : (
                <CircleAlert size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-accent" />
              )}
              <span className={cn("text-[0.8125rem]", !c.ok && "text-accent")}>{c.name}</span>
              <Meta className="min-w-0 truncate">{c.detail}</Meta>
            </div>
            {/* Only the broken one gets the room: the command that fixes it. */}
            {!c.ok && c.fix && (
              <span className="mt-1 ml-5 block rounded-md bg-sunk px-2 py-1 font-mono text-[0.6875rem] leading-relaxed text-ink-2">
                {c.fix}
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export interface ServerInfo {
  running: boolean;
  /** Which address we drive. Overridable, because the default may be taken. */
  addr: string;
  /** Plain HTTP to a host that is neither loopback nor an encrypted overlay. */
  inClear: boolean;
  /**
   * Which of the three cases this is, and it decides which control is offered:
   * a server we did not start is one we may report on and never act on.
   */
  state: "ours" | "theirs" | "stuck" | "started" | "down";
  why: string | null;
  pid: string | null;
  config: string | null;
  argv: string[];
  /** True only for a server this orchestrator started. */
  restartable: boolean;
  /** Host paths our mounts need that the running config will not allow. */
  drift: { want: string[]; config: string } | null;
  containers: number;
  runningTurns: number;
}

/** One line each, because the difference between them is what to do next. */
const SERVER_STATE: Record<ServerInfo["state"], { zh: string; ok: boolean }> = {
  ours: { zh: "在跑，我们起的", ok: true },
  started: { zh: "刚起好", ok: true },
  theirs: { zh: "在跑，不是我们起的，直接用", ok: true },
  stuck: { zh: "在跑，但我们驱动不了", ok: false },
  down: { zh: "没在跑", ok: false },
};

/**
 * Is the container server up, is its config still right, and how we reach it.
 *
 * One component, because it was two and the seam was visible: a status section
 * closed with its own rule, the key's field group opened with another one four
 * pixels below it, and a counter was threaded between them so that changing the
 * key made the status re-ask instead of going on saying 在跑，直接用 over a key
 * the server has never heard of. Merged, the re-ask is a function call and the
 * two settings share one field table.
 *
 * The order is what the eye needs in the order it needs it: which of five states
 * this is and the one button for it, why if why adds anything, then the only
 * thing on this pane that fails silently, then the two values that are merely
 * settings. It read as five equal blocks before, and a status line has to win.
 *
 * `allowed_host_paths` is the most valuable thing on the pane and it is not a
 * control: when the allowlist stops covering the staged skills directory nothing
 * fails loudly — every container mounts an empty directory instead, and the
 * agents simply do not have the skills the boss ticked. Preflight builds the
 * exact line to paste, so it is rendered selectable rather than described.
 *
 * The key is read rather than invented: it is what stands between a local port
 * and "create a container", and a key made up on this side is one the server has
 * never heard of — which this panel cannot restart the server to teach it. 从服务器读
 * takes it out of the server's own config, server-side, so the value never
 * reaches the browser.
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
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const d = props.server;
  const img = props.image;
  const load = props.onRefreshServer;

  const paths = props.checks.find((c) => c.name === "allowed_host_paths");
  const st = d ? SERVER_STATE[d.state] : null;
  // Two identifiers for one process, on one line. They were a Meta beside the
  // status and a Meta three rows below it, and neither is a fact you read on the
  // way to something else.
  const ident = [d?.pid && d.pid !== "?" ? `pid ${d.pid}` : null, d?.config].filter(Boolean).join(" · ");

  const restart = async () => {
    const yes = await ask({
      title: "重启沙盒服务器？",
      // The evidence beside the button: this is not a service bounce, it is
      // every container going away and every turn inside them dying with it.
      body:
        `所有容器都会没：${d?.containers ?? 0} 个组的沙盒，还有 ${d?.runningTurns ?? 0} 个正在跑的 turn。` +
        `\n\n没跑完的 turn 就白跑了，组会自己重开容器接着做，代码和分支不受影响。`,
      yes: "重启",
      danger: true,
    });
    if (!yes) return;
    setBusy(true);
    const r = await post("/api/sandbox-server/restart", {});
    setBusy(false);
    load();
    if (r.ok) toast.success("重启了，容器会按需重开");
  };

  const start = async () => {
    setBusy(true);
    const r = await post("/api/sandbox-server/start", {});
    setBusy(false);
    load();
    if (r.ok) toast.success("起来了");
  };

  /**
   * Adopt, replace or clear, and then ask the server again.
   *
   * The re-ask is the point of the merge: whether we can drive the server is a
   * function of the key, and clearing the key while the line above still reads
   * 在跑，直接用 is the shape this project keeps paying for — a stale answer that
   * looks like a healthy one.
   */
  const sendKey = async (body: Record<string, unknown>) => {
    setBusy(true);
    const res = await post("/api/auth", { runtime: "sandbox", ...body });
    setBusy(false);
    // Only on success. A rejected key wiped from the box makes the fix "paste it
    // again", which is never the fix.
    if (res.ok) setKey("");
    load();
    props.onSaved();
  };

  return (
    <>
      <Head title="沙盒服务器" note="开容器的那个服务" />

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {st ? (
          <>
            {st.ok ? (
              <Check size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-ok" />
            ) : (
              <CircleAlert size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-accent" />
            )}
            <span className={cn("text-[0.8125rem]", !st.ok && "text-accent")}>{st.zh}</span>
          </>
        ) : (
          <Meta>读取中…</Meta>
        )}
        <span className="grow" />
        {/* One control per state, and the two we must not offer are the point.
            A server we did not start is not ours to restart: killing it takes
            down whatever else on this machine was using it, and "we cannot
            drive it" is not evidence that nobody can. */}
        {d?.state === "down" ? (
          <Button size="sm" variant="go" disabled={busy} onClick={start}>
            {busy ? "起中…" : "起一个"}
          </Button>
        ) : d?.restartable ? (
          <Button size="sm" disabled={busy} onClick={restart}>
            {busy ? "重启中…" : "重启"}
          </Button>
        ) : d ? (
          <Tip label="这个进程不是我们起的，可能是你自己在用的那个。要重启就自己重启，之后这里会认得它。">
            <Button size="sm" disabled>
              重启
            </Button>
          </Tip>
        ) : null}
      </div>

      {/* Under the line it explains, indented past the icon, and only when it
          adds something — `没在跑` was rendering twice, once as the status and
          once as its own reason, which reads as a stuck panel. It was a bordered
          box on `sunk` too: a frame around one sentence, on the surface reserved
          for what a machine produced. */}
      {d?.why && d.why !== st?.zh && <p className="mt-1 ml-5 text-[0.75rem] leading-relaxed text-ink-2">{d.why}</p>}
      {ident && <Meta className="mt-1 ml-5 block truncate">{ident}</Meta>}

      {/* Silent when wrong, so it is loud here: a path missing from the
          allowlist mounts an empty directory rather than failing. */}
      {(d?.drift || (paths && !paths.ok)) && (
        <div className="mt-2.5 rounded-md bg-sunk px-3 py-2">
          <div className="text-[0.8125rem] text-accent">{d?.drift ? "配置里没允许我们要挂的路径" : paths!.detail}</div>
          <p className="mt-1 text-[0.75rem] text-ink-3">
            容器不报错，只挂个空目录，勾上的技能就这么没了。把这行写进配置，然后重启：
          </p>
          <pre className="mt-1.5 overflow-x-auto font-mono text-[0.6875rem] leading-relaxed text-ink-2 select-all">
            {d?.drift
              ? `allowed_host_paths = [${d.drift.want.map((p) => `"${p}"`).join(", ")}]`
              : paths?.fix?.split("\n").slice(-1)[0]!.trim()}
          </pre>
        </div>
      )}

      {/* The status band above is one section, these two values are another, and
          the gap is what says so. */}
      <FieldGroup className="mt-6">
        {/* The other way out of "that one is not ours", and the reason this is a
            control rather than a yaml key: the fix for a taken port is a
            different port, and an edit-and-restart is not a fix you make while
            reading this. */}
        <Field>
          <FieldLabel htmlFor="sb-addr">地址</FieldLabel>
          {/* A column, because the warning under the box is a third child and a
              two-column grid put it in the label gutter. */}
          <FieldContent className="flex-col items-stretch gap-1">
            <Input
              id="sb-addr"
              className="font-mono"
              placeholder="127.0.0.1:8080 或 https://host:port"
              defaultValue={d?.addr ?? ""}
              onKeyDown={async (e) => {
                if (e.key !== "Enter") return;
                const v = (e.target as HTMLInputElement).value;
                const r = await post("/api/sandbox-server/addr", { addr: v });
                load();
                if (r.ok) toast.success(v.trim() ? `改成 ${v.trim()} 了` : "改回配置文件里的了");
              }}
            />
            {/* The server does not have to be on this machine — a Tailscale peer
                or a cloud box works. Over WireGuard plain HTTP is fine, which is
                why this warns rather than refuses: on the open internet the
                api_key and every container payload cross it in the clear. */}
            {d?.inClear && (
              <span className="text-[0.75rem] text-accent">
                不在本机，也不在加密内网，走的还是明文 http。密钥和容器流量都是裸的，用 https 或者 Tailscale。
              </span>
            )}
          </FieldContent>
        </Field>

        {/* One default for the machine, so registering a repository needs no
            answer here at all: a new project sets no image and gets this one,
            the same way it gets the remote's default branch without being
            asked. The per-project row overrides it and is usually left alone. */}
        <ImageRow
          label="默认镜像"
          value={img}
          busy={busy}
          placeholder="新项目默认用它，留空跟配置文件"
          onSave={async (v) => {
            setBusy(true);
            const r = await post("/api/sandbox/images", { image: v });
            setBusy(false);
            if (r.ok) {
              // Re-read rather than assume: what the row shows is the server's
              // answer, and a write that was accepted is not a write that stored
              // this exact string.
              props.onRefreshImages();
              toast.success(v ? `以后新项目都用 ${v}` : "改回配置文件里的了");
            }
          }}
        />

        <Field>
          <FieldLabel htmlFor="sandbox-key">密钥</FieldLabel>
          <InputGroup>
            <Input
              id="sandbox-key"
              className="min-w-0 flex-1 font-mono"
              // What is stored, in the box that stores it — same as the accounts.
              placeholder={props.current ? `已存 ${props.current.hint}，粘新的就换掉` : "留空 = 服务器没开鉴权"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            {/* The server owns this value, so it is read rather than invented. */}
            <Tip label="从沙盒服务器自己的配置里读（OPENSANDBOX_CONFIG、./sandbox.toml、~/.sandbox.toml）。值不经过浏览器。">
              <Button size="sm" disabled={busy} onClick={() => void sendKey({ mode: "api_key", adopt: true })}>
                从服务器读
              </Button>
            </Tip>
            {/* A key nobody told the server about locks the whole fleet out, and
                until this button existed there was no way back from the panel
                that put it there. */}
            {props.current && (
              <Button size="sm" variant="quiet" disabled={busy} onClick={() => void sendKey({ clear: true })}>
                清掉
              </Button>
            )}
            {/* Only once there is something to save, same as every other field in
                this dialog. A button that is always there and usually does
                nothing trains you to ignore it. */}
            {key.trim() && (
              <Button
                variant="go"
                size="sm"
                disabled={busy}
                onClick={() => void sendKey({ mode: "api_key", secret: key.trim() })}
              >
                存下
              </Button>
            )}
          </InputGroup>
        </Field>
      </FieldGroup>
      {/* No "now put this in the server's config" line: that instruction is what
          got followed halfway, and a key only this side knows locks the fleet out
          of every container. 存下 refuses a key the server rejects. */}
    </>
  );
}
