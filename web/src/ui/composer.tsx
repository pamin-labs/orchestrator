import * as Dialog from "@radix-ui/react-dialog";
import { ClipboardPaste, Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./button";
import { Textarea } from "./bits";
import { Card, CardHeader, CardTitle } from "./card";
import { cn } from "../lib/utils";

export interface Attached { name: string; path: string; type: string; size: number; url?: string }
export interface Draft {
  text: string;
  attachments: { name: string; path: string; type: string }[];
}

/**
 * Everything the boss types, typed the same way.
 *
 * There were four of these: the idea dialog with attachments and paste, a bare
 * textarea for talking to the group, and two one-line inputs for "why I am sending
 * this back". A screenshot is exactly as useful attached to "这里不对" as to a new
 * idea, and the reasons the boss gives are the highest-value text in the system —
 * they become blackboard facts the whole group reasons from. One component, so
 * every one of them gets files, paste, ⌘Enter and the same failure messages.
 *
 * Files are uploaded on drop and referenced by path; contents never enter a prompt.
 */
export function Composer({
  placeholder,
  rows = 3,
  submit,
  onSubmit,
  actions,
  autoFocus,
  className,
}: {
  placeholder?: string;
  rows?: number;
  /** Label of the primary action. Omit for a composer whose actions are all custom. */
  submit?: string;
  /** Return true to clear. */
  onSubmit?: (d: Draft) => Promise<boolean> | boolean;
  /** Extra actions that need the current text, e.g. triage. */
  actions?: (d: Draft & { busy: boolean; clear: () => void }) => React.ReactNode;
  autoFocus?: boolean;
  className?: string;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attached[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const clear = () => {
    setText("");
    setFiles([]);
  };
  const draft: Draft = { text: text.trim(), attachments: files.map(({ name, path, type }) => ({ name, path, type })) };

  const upload = async (list: FileList | File[]) => {
    const picked = [...list];
    if (!picked.length) return;
    const form = new FormData();
    for (const f of picked) form.append("file", f);
    setBusy(true);
    const r = await fetch("/api/attach", { method: "POST", body: form });
    setBusy(false);
    // A file that silently fails to attach is worse than one never added: the text
    // goes out referencing a path, and the agent is told to Read something missing.
    if (!r.ok) return void toast.error(await r.text(), { duration: 8000 });
    const { files: saved } = (await r.json()) as { files: Attached[] };
    setFiles((prev) => [
      ...prev,
      ...saved.map((s, i) => ({
        ...s,
        // Preview from the local File, not a server round trip.
        url: picked[i]?.type.startsWith("image/") ? URL.createObjectURL(picked[i]!) : undefined,
      })),
    ]);
  };

  /**
   * Read the clipboard on demand.
   *
   * ⌘V works too, but only while this box has focus — and the usual order is
   * screenshot first, open the panel second, by which point the muscle memory is
   * spent. Text joins the message, images become attachments.
   */
  const pasteClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      const grabbed: File[] = [];
      for (const it of items) {
        const img = it.types.find((t) => t.startsWith("image/"));
        if (img) {
          const blob = await it.getType(img);
          grabbed.push(new File([blob], `pasted-${grabbed.length + 1}.${img.split("/")[1] ?? "png"}`, { type: img }));
        } else if (it.types.includes("text/plain")) {
          const t = (await (await it.getType("text/plain")).text()).trim();
          if (t) setText((prev) => (prev ? `${prev}\n${t}` : t));
        }
      }
      if (grabbed.length) await upload(grabbed);
      else if (!items.length) toast.error("剪贴板是空的");
    } catch {
      // Safari and a denied permission both land here.
      toast.error("浏览器不让直接读剪贴板。点进输入框按 ⌘V 一样可以，图片也认。", { duration: 8000 });
    }
  };

  const send = async () => {
    if (!draft.text || !onSubmit) return;
    setBusy(true);
    const ok = await onSubmit(draft);
    setBusy(false);
    if (ok) clear();
  };

  return (
    <div
      className={cn("rounded-lg border border-rule transition-colors", drag && "border-accent bg-accent-soft", className)}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void upload(e.dataTransfer.files);
      }}
      onPaste={(e) => {
        const f = [...e.clipboardData.files];
        if (f.length) {
          e.preventDefault();
          void upload(f);
        }
      }}
    >
      <Textarea
        autoFocus={autoFocus}
        rows={rows}
        className="rounded-b-none border-0 font-sans text-[0.875rem] focus:ring-0"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2 pb-2">
          {files.map((f, i) => (
            <div key={f.path} className="flex items-center gap-2 rounded-md border border-rule bg-paper px-2 py-1.5">
              {f.url ? (
                <img src={f.url} alt="" className="size-9 rounded object-cover" />
              ) : (
                <span className="grid size-9 place-items-center rounded bg-sunk font-mono text-[0.5625rem] text-ink-3">
                  {(f.name.split(".").pop() ?? "file").slice(0, 4).toUpperCase()}
                </span>
              )}
              <span className="max-w-40 truncate text-[0.75rem]">{f.name}</span>
              <span className="font-mono text-[0.625rem] text-ink-3">{Math.round(f.size / 1024)}k</span>
              <button
                aria-label={`移除 ${f.name}`}
                className="cursor-pointer text-ink-3 hover:text-bad"
                onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 border-t border-rule-soft px-2 py-1.5">
        <input ref={input} type="file" multiple className="hidden"
               onChange={(e) => e.target.files && upload(e.target.files)} />
        <Button variant="quiet" size="sm" onClick={() => input.current?.click()}>
          <Paperclip size={12} strokeWidth={1.75} /> 附件
        </Button>
        <Button variant="quiet" size="sm" onClick={pasteClipboard}>
          <ClipboardPaste size={12} strokeWidth={1.75} /> 粘贴
        </Button>
        <span className="grow" />
        {actions?.({ ...draft, busy, clear })}
        {submit && onSubmit && (
          <Button variant="go" size="sm" disabled={busy || !draft.text} onClick={send}>
            {busy ? "…" : submit}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The same composer, in a dialog, for the places that interrupt rather than sit inline. */
export function ComposerDialog({
  open, onOpenChange, title, hint, placeholder, submit, onSubmit, rows = 5,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  hint?: string;
  placeholder?: string;
  submit: string;
  onSubmit: (d: Draft) => Promise<boolean> | boolean;
  rows?: number;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--scrim)]" />
        <Dialog.Content
          className="fixed left-1/2 top-[15%] z-50 w-[min(40rem,94vw)] -translate-x-1/2 overflow-hidden rounded-xl
                     border border-rule bg-paper shadow-[0_12px_40px_var(--shade)] fade-in"
        >
          <Card className="rounded-none border-0">
            <CardHeader className="block">
              <Dialog.Title asChild><CardTitle>{title}</CardTitle></Dialog.Title>
              {hint && (
                <Dialog.Description className="mt-1 text-[0.75rem] text-ink-3">{hint}</Dialog.Description>
              )}
            </CardHeader>
            <div className="p-3.5">
              <Composer
                autoFocus
                rows={rows}
                placeholder={placeholder}
                submit={submit}
                onSubmit={async (d) => {
                  const ok = await onSubmit(d);
                  if (ok) onOpenChange(false);
                  return ok;
                }}
                actions={() => (
                  <Button size="sm" onClick={() => onOpenChange(false)}>取消</Button>
                )}
              />
            </div>
          </Card>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
