import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/bits";
import { post } from "../lib/api";
import { cn } from "../lib/utils";

interface Attached { name: string; path: string; type: string; size: number; url?: string }

/**
 * Dropping an idea, with room to write it and files to go with it.
 *
 * One line was too short: an idea is often two or three sentences, and a
 * screenshot of the bug says more than any of them. Files are uploaded to disk and
 * referenced by path in the note, never inlined into the prompt — an image costs
 * thousands of tokens on every turn that carries it, a path costs a dozen and the
 * agent opens it once, when it needs to.
 */
export function NewRequirement({
  open, onOpenChange, projectId, onDone,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; projectId: number; onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attached[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (list: FileList | File[]) => {
    const picked = [...list];
    if (!picked.length) return;
    const form = new FormData();
    for (const f of picked) form.append("file", f);
    setBusy(true);
    const r = await fetch("/api/attach", { method: "POST", body: form });
    setBusy(false);
    if (!r.ok) return;
    const { files: saved } = (await r.json()) as { files: Attached[] };
    setFiles((prev) => [
      ...prev,
      ...saved.map((s, i) => ({
        ...s,
        // Preview from the local File, not from a server round trip.
        url: picked[i]?.type.startsWith("image/") ? URL.createObjectURL(picked[i]!) : undefined,
      })),
    ]);
  };

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const r = await post("/api/ideas", {
      project_id: projectId,
      text: text.trim(),
      attachments: files.map(({ name, path, type }) => ({ name, path, type })),
    });
    setBusy(false);
    if (r.ok) {
      setText("");
      setFiles([]);
      onOpenChange(false);
      onDone();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[oklch(0.2_0.01_70/0.35)]" />
        <Dialog.Content
          className="fixed left-1/2 top-[15%] z-50 w-[min(40rem,94vw)] -translate-x-1/2 overflow-hidden rounded-xl
                     border border-rule bg-paper shadow-[0_12px_40px_oklch(0_0_0/0.18)] fade-in"
          onPaste={(e) => {
            const f = [...e.clipboardData.files];
            if (f.length) { e.preventDefault(); void upload(f); }
          }}
        >
          <div className="border-b border-rule p-3.5">
            <Dialog.Title className="font-display text-[1.0625rem] font-semibold">新需求</Dialog.Title>
            <Dialog.Description className="mt-1 text-[0.75rem] text-ink-3">
              说清要什么就够，不用写文档。产出计划卡待批，批准前不写代码。
            </Dialog.Description>
          </div>

          <div
            className={cn("p-3.5", drag && "bg-accent-soft")}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files); }}
          >
            <Textarea
              autoFocus
              rows={6}
              className="font-sans text-[0.875rem]"
              placeholder={"例：登录页加「记住我」，勾了之后 30 天不用重新登录。\n附上截图或设计稿也行，拖进来、粘贴、或点下面的按钮。"}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
              }}
            />

            {files.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {files.map((f, i) => (
                  <div key={f.path} className="relative flex items-center gap-2 rounded-md border border-rule px-2 py-1.5">
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
          </div>

          <div className="flex items-center gap-2 border-t border-rule p-3.5">
            <input
              ref={input}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && upload(e.target.files)}
            />
            <Button onClick={() => input.current?.click()}>附加文件…</Button>
            <span className="text-[0.6875rem] text-ink-3">也可以拖进来或直接粘贴截图</span>
            <span className="grow" />
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button variant="go" disabled={!text.trim() || busy} onClick={submit}>
              {busy ? "提交中…" : "提交"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
