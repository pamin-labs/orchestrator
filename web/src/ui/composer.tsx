import * as Dialog from "@radix-ui/react-dialog";
import { ClipboardPaste, Paperclip, SquareSlash, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./button";
import { Textarea } from "./bits";
import { Card, CardHeader, CardTitle } from "./card";
import { ask } from "./confirm";
import { cn } from "../lib/utils";
import { FilePicker } from "../views/picker";
import { z } from "zod";
import { api, readApi, readJson } from "../lib/api";
import type { InferResponseType } from "hono/client";

const AttachedSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.string(),
  size: z.number(),
  url: z.string().optional(),
  label: z.string(),
});
type Attached = z.infer<typeof AttachedSchema>;
/** A file and where it sat inside whatever was dropped. */
interface Picked {
  file: File;
  rel: string;
}

const isFileEntry = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile;
const isDirectoryEntry = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry => entry.isDirectory;

/**
 * Everything under what was dropped, folders included.
 *
 * `DataTransfer.files` skips directories entirely — drop a folder and the list is
 * either empty or holds one entry whose bytes cannot be read. `webkitGetAsEntry`
 * is the only way in, it is in every browser that matters despite the prefix, and
 * the items have to be captured synchronously: the DataTransfer empties as soon
 * as the drop handler yields.
 */
async function walk(items: DataTransferItemList): Promise<Picked[]> {
  const roots = [...items]
    .map((i) => i.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => entry !== null && entry !== undefined);
  const out: Picked[] = [];
  const one = (e: FileSystemEntry, prefix: string): Promise<void> =>
    new Promise((done) => {
      if (isFileEntry(e)) {
        e.file(
          (f) => {
            out.push({ file: f, rel: prefix + e.name });
            done();
          },
          () => done(),
        );
        return;
      }
      if (!isDirectoryEntry(e)) return done();
      const reader = e.createReader();
      // readEntries hands back at most a hundred at a time and signals the end
      // with an empty batch.
      const batch = () =>
        reader.readEntries(
          async (list) => {
            if (!list.length) return done();
            await Promise.all(list.map((c) => one(c, `${prefix + e.name}/`)));
            batch();
          },
          () => done(),
        );
      batch();
    });
  await Promise.all(roots.map((r) => one(r, "")));
  return out;
}
export const SkillSchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string(),
  scope: z.enum(["project", "user"]),
  on: z.boolean(),
});
export type Skill = z.infer<typeof SkillSchema>;
const DraftAttachmentSchema = AttachedSchema.pick({ name: true, path: true, type: true, label: true });
const DraftSchema = z.object({ text: z.string(), attachments: z.array(DraftAttachmentSchema) });
export type Draft = z.infer<typeof DraftSchema>;

const SavedAttachmentSchema = AttachedSchema.omit({ label: true, url: true });
type SavedAttachment = z.infer<typeof SavedAttachmentSchema>;
const AttachmentsSchema: z.ZodType<
  InferResponseType<typeof api.attach.$post, 200> & InferResponseType<typeof api.attach.local.$post, 200>
> = z.object({ files: z.array(SavedAttachmentSchema) });

const SkillsResponseSchema: z.ZodType<InferResponseType<typeof api.skills.$get, 200>> = z.object({
  skills: z.array(SkillSchema),
});

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
/**
 * The skill list, fetched once per project for the life of the page.
 *
 * Without a project this returns the user-level ones. A box that takes a
 * screenshot and a box that takes an idea are the same box (that is why there is
 * one component), and half of them silently had no `/` because whoever wired them
 * up did not have a project id to hand.
 *
 * Cached at module scope because composers mount constantly — every reseed is a
 * remount — and the list changes when a file lands on disk, not between two
 * clicks.
 */
const SKILLS = new Map<string, Skill[]>();
const SKILLS_IN_FLIGHT = new Map<string, Promise<Skill[]>>();

const cachedSkills = (projectId?: number): Skill[] | null => SKILLS.get(String(projectId ?? "")) ?? null;

/** Ticking a skill in settings changes `on` here; the cache would say otherwise. */
export const forgetSkills = () => SKILLS.clear();

function fetchSkills(key: string, projectId?: number): Promise<Skill[]> {
  const p = readApi(api.skills.$get({ query: { project: String(projectId ?? "") } }), SkillsResponseSchema)
    .then((d) => d?.skills ?? [])
    .catch(() => [])
    .then((list) => {
      SKILLS.set(key, list);
      SKILLS_IN_FLIGHT.delete(key);
      return list;
    });
  SKILLS_IN_FLIGHT.set(key, p);
  return p;
}

function loadSkills(projectId?: number): Promise<Skill[]> {
  const key = String(projectId ?? "");
  const done = SKILLS.get(key);
  if (done) return Promise.resolve(done);
  return SKILLS_IN_FLIGHT.get(key) ?? fetchSkills(key, projectId);
}

export function Composer({
  placeholder,
  rows = 3,
  submit,
  onSubmit,
  actions,
  autoFocus,
  className,
  projectId,
  initial,
}: {
  placeholder?: string;
  rows?: number;
  /** Enables the `/` skill picker: skills come from that project's repo. */
  projectId?: number;
  /** Label of the primary action. Omit for a composer whose actions are all custom. */
  submit?: string;
  /** Return true to clear. */
  onSubmit?: (d: Draft) => Promise<boolean> | boolean;
  /** Extra actions that need the current text, e.g. triage. */
  actions?: (d: Draft & { busy: boolean; clear: () => void }) => React.ReactNode;
  autoFocus?: boolean;
  className?: string;
  /** Seed text. Remount (a changing `key`) to reseed — this is a starting point,
   *  not a controlled value; the box belongs to whoever is typing in it. */
  initial?: string;
}) {
  const [text, setText] = useState(initial ?? "");
  const [files, setFiles] = useState<Attached[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  // Read from the module cache synchronously, so a composer that remounts (every
  // 填进输入框 does) starts with the list it had. Without it the 插技能 button
  // popped in a beat after the other two on every open — the fetch is fast, but
  // "fast" is exactly the timing that reads as a flicker.
  const [skills, setSkills] = useState<Skill[] | null>(cachedSkills(projectId));
  const [slash, setSlash] = useState<{ from: number; q: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // Measured from the element rather than counted from the text: a wrapped line
  // is a line, and counting `\n` gets that wrong on exactly the long answers
  // this box exists for.
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "0px";
    setH(Math.max(el.scrollHeight, rows * 22));
    el.style.height = "";
  }, [text, rows]);

  /**
   * `/` offers the skills the orchestrator can hand an agent.
   *
   * Not slash commands: agents run with `--disable-slash-commands` (the catalogue is
   * ~46k cached tokens of prefix on every turn) and without the boss's user-level
   * setup (~195k on a trivial turn). Instead the orchestrator reads the SKILL.md
   * itself, on the host, and appends its text to that one turn — so a `~/.claude`
   * skill reaches an agent that cannot see the file, and a skill used once is paid
   * for once.
   */
  useEffect(() => {
    if (skills) return;
    void loadSkills(projectId).then(setSkills);
  }, [projectId, skills]);

  const onType = (v: string, caret: number) => {
    setText(v);
    // A slash only opens the picker at the start of a word.
    const upto = v.slice(0, caret);
    const m = /(?:^|\s)\/([\w.:-]*)$/.exec(upto);
    setSlash(m && (skills?.length ?? 0) > 0 ? { from: caret - m[1]!.length - 1, q: m[1]!.toLowerCase() } : null);
  };

  /** Drop the `/query` that opened the picker, leaving the rest of the sentence. */
  const dropSlash = () => {
    if (!slash) return;
    setText(text.slice(0, slash.from) + text.slice(slash.from + slash.q.length + 1));
    setSlash(null);
    box.current?.focus();
  };

  const insertSkill = async (sk: Skill) => {
    if (!slash) return;
    // An unticked skill is not in the sandbox mount. Naming it here still works —
    // the text is injected into this one turn — but the agent cannot reach for it
    // on its own afterwards, and that difference is invisible from the picker.
    if (!sk.on) {
      const go = await ask({
        title: `${sk.name} 没启用`,
        body: "没勾选的技能不在沙盒里，agent 自己找不到它。去设置里勾上，还是取消这次插入？",
        yes: "去设置",
      });
      dropSlash();
      if (!go) return;
      const h = new URLSearchParams(location.hash.slice(1));
      h.set("v", "skills");
      location.hash = h.toString();
      return;
    }
    // `/name`, not the path. The path was a file on this machine; a turn runs in a
    // container where the boss's skills are mounted somewhere else entirely, and
    // `/name` is what both CLIs resolve wherever the skill actually sits.
    const next = `${text.slice(0, slash.from)}/${sk.name} `;
    setText(next + text.slice(slash.from + slash.q.length + 1));
    setSlash(null);
    box.current?.focus();
  };
  const matches = (skills ?? []).filter(
    (sk) => !slash?.q || sk.name.toLowerCase().includes(slash.q) || sk.path.toLowerCase().includes(slash.q),
  );

  const clear = () => {
    setText("");
    setFiles([]);
  };
  const draft: Draft = {
    text: text.trim(),
    attachments: files.map(({ name, path, type, label }) => ({ name, path, type, label })),
  };

  /**
   * A name for each file, written into the text where it was added.
   *
   * Two screenshots and a sentence saying "这里不对" leaves the agent guessing which
   * one 这里 is — and the agent cannot ask cheaply, because asking costs the boss a
   * turn in 待办. So every attachment gets 图N / 附件N, the marker goes in at the
   * caret, and the same marker labels the path in the assembled prompt. The text
   * can then say 按 [图2] 改, and both ends mean the same file.
   */
  const label = (f: { type: string }, taken: string[]) => {
    const kind = f.type === "inode/directory" ? "目录" : f.type.startsWith("image/") ? "图" : "附件";
    const n = taken.filter((l) => l.startsWith(kind)).length + 1;
    return `${kind}${n}`;
  };

  const addFiles = (saved: SavedAttachment[], previews: Array<string | undefined> = []) => {
    // Label before the state update: the updater has not run when the text
    // markers are assembled, so doing it there produced `[undefined]`.
    const taken = files.map((file) => file.label);
    const marked = saved.map((file, index) => {
      const next = label(file, taken);
      taken.push(next);
      return { ...file, label: next, url: previews[index] };
    });
    setFiles((prev) => [...prev, ...marked]);
    mark(marked.map((file) => `[${file.label}]`).join(""));
  };

  /**
   * Attach what is already on this machine, by path.
   *
   * The file input can pick neither a folder nor several things of mixed kinds,
   * and everything it does pick it reads into memory to post straight back to the
   * same disk. Our own picker walks the real filesystem, so a folder is one click.
   */
  const fromDisk = async (paths: string[]) => {
    setBusy(true);
    const r = await api.attach.local.$post({ json: { paths } }).catch(() => null);
    setBusy(false);
    if (!r) return void toast.error("加不进来", { duration: 8000 });
    const result = await readJson(r, AttachmentsSchema);
    if (!result.ok) return void toast.error(result.text, { duration: 8000 });
    addFiles(result.data.files);
  };

  /** Drop the markers in where the caret was. */
  const mark = (marks: string) => {
    const box2 = box.current;
    const at = box2 ? (box2.selectionStart ?? text.length) : text.length;
    setText(`${text.slice(0, at)}${marks}${text.slice(at)}`);
    requestAnimationFrame(() => {
      box2?.focus();
      box2?.setSelectionRange(at + marks.length, at + marks.length);
    });
  };

  const upload = async (list: FileList | File[] | Picked[]) => {
    const picked: Picked[] = [...list].map((f) => (f instanceof File ? { file: f, rel: f.name } : f));
    if (!picked.length) return;
    setBusy(true);
    // A folder copied in Finder arrives as an unreadable zero-byte entry and the
    // fetch dies with ERR_ACCESS_DENIED — as an unhandled rejection in the console
    // and nothing at all on screen.
    let r: Response;
    try {
      // Relative paths travel beside files so the server can rebuild a folder as
      // one attachment. Hono RPC owns the multipart encoding and route contract.
      r = await api.attach.$post({
        form: {
          file: picked.map(({ file }) => file),
          rel: picked.map(({ rel }) => rel),
        },
      });
    } catch {
      setBusy(false);
      return void toast.error("浏览器读不到这些内容。文件夹得拖进来。", { duration: 8000 });
    }
    setBusy(false);
    // A file that silently fails to attach is worse than one never added: the text
    // goes out referencing a path, and the agent is told to Read something missing.
    const result = await readJson(r, AttachmentsSchema);
    if (!result.ok) return void toast.error(result.text, { duration: 8000 });
    // Preview from the local File, not a server round trip.
    addFiles(
      result.data.files,
      picked.map(({ file }) => (file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined)),
    );
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
      toast.error("浏览器不让直接读剪贴板。点进输入框按 ⌘V，图片也认。", { duration: 8000 });
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
      className={cn(
        "rounded-lg border border-rule transition-colors",
        drag && "border-accent bg-accent-soft",
        className,
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        // dataTransfer.files holds a dropped folder as one unreadable entry with
        // no contents; the entry API is the only way to walk into it.
        void walk(e.dataTransfer.items).then((picked) => upload(picked.length ? picked : e.dataTransfer.files));
      }}
      onPaste={(e) => {
        const f = [...e.clipboardData.files];
        if (f.length) {
          e.preventDefault();
          void upload(f);
        }
      }}
    >
      {/* Grows with what is in it, up to a point, and never smaller than `rows`.
          A fixed box meant a four-line answer was written through a two-line
          window with a drag handle nobody uses, and the drafted answer that
          arrives in it is usually three or four lines long. */}
      <Textarea
        ref={box}
        autoFocus={autoFocus}
        rows={rows}
        // 36rem, not 18: an answer to a watchdog escalation quotes three verdicts
        // and runs past twenty lines, and a box that stops growing at half of that
        // is a window you write a page through.
        style={{ height: h ? `${h}px` : undefined, maxHeight: "36rem" }}
        className="resize-none overflow-y-auto rounded-b-none border-0 font-sans text-[0.875rem] focus:ring-0"
        placeholder={placeholder}
        value={text}
        onChange={(e) => onType(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onKeyDown={(e) => {
          if (slash && (e.key === "Escape" || e.key === "Tab")) {
            e.preventDefault();
            if (e.key === "Tab" && matches[0]) void insertSkill(matches[0]);
            else setSlash(null);
            return;
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />

      {slash && matches.length > 0 && (
        <div className="mx-2 mb-1 overflow-hidden rounded-md border border-rule bg-paper shadow-[0_6px_20px_var(--shade)]">
          <div className="flex items-baseline gap-2 border-b border-rule-soft px-2 py-1 text-[0.6875rem] text-ink-3">
            <span className="min-w-0 grow">选中的技能，正文随这一个 turn 发给 agent，只花这一次钱</span>
            <span className="shrink-0 font-mono">{matches.length}</span>
          </div>
          {/* Scrolls, capped by height. It used to render the first six and stop —
              with no count and no scrollbar, a skill that sorted seventh did not
              exist as far as the boss could tell, and typing more of its name was
              the only way to find out otherwise. */}
          <div className="max-h-56 overflow-y-auto">
            {matches.map((sk) => (
              <button
                key={sk.path}
                onClick={() => insertSkill(sk)}
                className="flex w-full cursor-pointer items-baseline gap-2 px-2 py-1.5 text-left hover:bg-sunk"
              >
                <span className="font-mono text-[0.75rem] text-ink">{sk.name}</span>
                {/* Where it came from matters: a project skill is versioned with the
                  code, a user one is the boss's own and shadowed by the project's. */}
                <span className="shrink-0 font-mono text-[0.5625rem] text-ink-3">
                  {sk.scope === "project" ? "项目" : "全局"}
                </span>
                {/* Still offerable — the text is injected either way — but the agent
                  cannot reach for this one by itself until it is ticked. */}
                {!sk.on && <span className="shrink-0 font-mono text-[0.5625rem] text-ink-3">未启用</span>}
                <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-ink-3">{sk.description}</span>
                <span className="shrink-0 font-mono text-[0.625rem] text-ink-3">Tab</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2 pb-2">
          {files.map((f, i) => (
            <div key={f.path} className="flex items-center gap-2 rounded-md border border-rule bg-paper px-2 py-1.5">
              {f.url ? (
                <img src={f.url} alt="" className="size-9 rounded object-cover" />
              ) : (
                <span className="grid size-9 place-items-center rounded bg-sunk font-mono text-[0.5625rem] text-ink-3">
                  {f.type === "inode/directory" ? "DIR" : (f.name.split(".").pop() ?? "file").slice(0, 4).toUpperCase()}
                </span>
              )}
              <span className="font-mono text-[0.6875rem] text-ink-2">[{f.label}]</span>
              <span className="max-w-40 truncate text-[0.75rem]">{f.name}</span>
              {f.type !== "inode/directory" && (
                <span className="font-mono text-[0.625rem] text-ink-3">{Math.round(f.size / 1024)}k</span>
              )}
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
        <FilePicker open={picking} onOpenChange={setPicking} onPick={fromDisk} />
        <Button variant="quiet" size="sm" onClick={() => setPicking(true)}>
          <Paperclip size={12} strokeWidth={1.75} /> 附件
        </Button>
        <Button variant="quiet" size="sm" onClick={pasteClipboard}>
          <ClipboardPaste size={12} strokeWidth={1.75} /> 粘贴
        </Button>
        {/* A button, like the two beside it. It was a 0.625rem mono hint sitting on
            the same row as two 0.75rem buttons with icons — three controls, three
            shapes, and the only one that did nothing when clicked was the one that
            named a keystroke nobody had been told about. */}
        {(skills?.length ?? 0) > 0 && (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              const box2 = box.current;
              const at = box2?.selectionStart ?? text.length;
              // Typing the slash for them, so the picker opens the same way it does
              // when they type it themselves — one code path, not two.
              onType(`${text.slice(0, at)}/${text.slice(at)}`, at + 1);
              requestAnimationFrame(() => {
                box2?.focus();
                box2?.setSelectionRange(at + 1, at + 1);
              });
            }}
          >
            <SquareSlash size={12} strokeWidth={1.75} /> 插技能
          </Button>
        )}
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
  open,
  onOpenChange,
  title,
  hint,
  placeholder,
  submit,
  onSubmit,
  rows = 5,
  projectId,
}: {
  projectId?: number;
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
              <Dialog.Title asChild>
                <CardTitle>{title}</CardTitle>
              </Dialog.Title>
              {hint && <Dialog.Description className="mt-1 text-[0.75rem] text-ink-3">{hint}</Dialog.Description>}
            </CardHeader>
            <div className="p-3.5">
              <Composer
                autoFocus
                {...(projectId !== undefined ? { projectId } : {})}
                rows={rows}
                {...(placeholder !== undefined ? { placeholder } : {})}
                submit={submit}
                onSubmit={async (d) => {
                  const ok = await onSubmit(d);
                  if (ok) onOpenChange(false);
                  return ok;
                }}
                actions={() => (
                  <Button size="sm" onClick={() => onOpenChange(false)}>
                    取消
                  </Button>
                )}
              />
            </div>
          </Card>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
