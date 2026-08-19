import * as P from "@radix-ui/react-popover";
import * as T from "@radix-ui/react-tooltip";
import { CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * `title=` is the browser's tooltip: a second of delay, no styling, no keyboard
 * path, and it never appears on touch. Radix gives the behaviour — hover intent,
 * focus, escape, aria-describedby — and the package was already installed.
 */
export const TipRoot = ({ children }: { children: React.ReactNode }) => (
  <T.Provider delayDuration={250} skipDelayDuration={100}>
    {children}
  </T.Provider>
);

export function Tip({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  if (!label) return <>{children}</>;
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          sideOffset={5}
          className="fade-in z-50 max-w-[22rem] rounded-md border border-rule bg-paper px-2 py-1
                     text-[0.75rem] text-ink shadow-[0_6px_20px_var(--shade)]"
        >
          {label}
          <T.Arrow className="fill-[var(--color-rule)]" />
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

/**
 * The same job as `Tip` at the length where hovering stops working.
 *
 * The reason a setting's default is what it is runs to five or six lines — a
 * measurement someone paid for, and the thing that decides whether the number gets
 * changed back. A tooltip is the wrong container: it needs the pointer parked on
 * the trigger, so it closes the moment the reader moves toward the field they came
 * to edit, and it never opens at all on touch.
 */
/**
 * A popover is clicked open, stays open while the value is being typed, closes on
 * Escape or an outside click, and is reachable from the keyboard. Radix Popover,
 * already in the tree for the combobox. Both live in this file because they are one
 * decision with a threshold: a phrase hovers, a paragraph is clicked.
 */
export function Help({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <P.Root>
      <P.Trigger
        aria-label={t("ui.tooltip.whyThisValue", "为什么是这个值")}
        className="cursor-pointer rounded-full text-ink-3 transition-colors duration-150
                   hover:text-ink data-[state=open]:text-ink"
      >
        <CircleHelp className="size-3.5" strokeWidth={1.75} />
      </P.Trigger>
      <P.Portal>
        <P.Content
          // Down and to the left, never sideways: the value this explains is in
          // the column to the right of the `?`, and a panel that lands on top of
          // the field you are about to type in is a panel you have to dismiss
          // before you can use what it just told you.
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="fade-in z-50 w-[24rem] max-w-[min(24rem,90vw)] rounded-lg border border-rule bg-paper
                     px-3 py-2.5 text-[0.75rem] leading-relaxed text-ink-2 shadow-[0_8px_28px_var(--shade)]"
        >
          {children}
          <P.Arrow className="fill-[var(--color-rule)]" />
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
