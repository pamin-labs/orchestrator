import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Textarea } from "./bits";

/**
 * Confirmations are ours, not the browser's.
 *
 * A native confirm() is the browser's chrome: different type, different buttons,
 * different language, and no way to say what the consequence is. Radix supplies
 * the behaviour this needs and hand-rolling never got right — focus trap, escape,
 * restoring focus, aria wiring.
 */
export interface AskSpec {
  title: string;
  body?: string;
  yes?: string;
  danger?: boolean;
  /** Turns it into a one-question form: resolves with the typed text. */
  field?: string;
}

let open: ((spec: AskSpec) => Promise<string | true | null>) | null = null;
export const ask = (spec: AskSpec) => open?.(spec) ?? Promise.resolve(null);

export function AskHost() {
  const [spec, setSpec] = useState<AskSpec | null>(null);
  const [text, setText] = useState("");
  const [resolve, setResolve] = useState<((v: string | true | null) => void) | null>(null);

  open = (s) =>
    new Promise((res) => {
      setText("");
      setSpec(s);
      setResolve(() => res);
    });

  const done = (v: string | true | null) => {
    resolve?.(v);
    setSpec(null);
    setResolve(null);
  };

  return (
    <Dialog.Root open={!!spec} onOpenChange={(o) => !o && done(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--scrim)]" />
        {spec && <AskCard spec={spec} text={text} onText={setText} onDone={done} />}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The card itself, told what it is asking rather than reading it back
 * optionally. The portal only mounts while a question is open, so every `spec?.`
 * inside it was a branch that could not be taken, and one of them decides which
 * button carries the consequence.
 */
export function AskCard({
  spec,
  text,
  onText,
  onDone,
}: {
  spec: AskSpec;
  text: string;
  onText: (v: string) => void;
  onDone: (v: string | true | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Content
      className="fixed left-1/2 top-1/3 z-50 w-[min(28rem,92vw)] -translate-x-1/2 rounded-xl
                 border border-rule bg-paper shadow-[0_12px_40px_var(--shade)] fade-in"
    >
      <div className="p-3.5">
        <Dialog.Title className="mb-1.5 font-display text-[1.0625rem] font-semibold">{spec.title}</Dialog.Title>
        {spec.body && <Dialog.Description className="text-[0.8125rem] text-ink-2">{spec.body}</Dialog.Description>}
        {spec.field && (
          <Textarea
            rows={3}
            className="mt-2.5"
            placeholder={spec.field}
            value={text}
            onChange={(e) => onText(e.target.value)}
          />
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-rule p-3.5">
        <span className="grow" />
        <Button onClick={() => onDone(null)}>{t("ui.confirm.cancel", "取消")}</Button>
        <Button variant={spec.danger ? "danger" : "go"} onClick={() => onDone(spec.field ? text : true)}>
          {spec.yes ?? t("ui.confirm.ok", "确定")}
        </Button>
      </div>
    </Dialog.Content>
  );
}
