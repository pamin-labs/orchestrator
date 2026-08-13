import * as T from "@radix-ui/react-tooltip";

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
