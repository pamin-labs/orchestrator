import { cn } from "../lib/utils";

/** Uppercase section label. Sans, never the display face: 宋体 is weak at 10px. */
export const H2 = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <h2 className={cn("text-[0.625rem] font-semibold uppercase tracking-[0.13em] text-ink-3 mb-3", className)}>
    {children}
  </h2>
);

/** A name. The display face earns its place here and at ≥15px only. */
export const Name = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span className={cn("font-display text-[1.0625rem] font-semibold", className)}>{children}</span>
);

export const Pill = ({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "mine" | "live" | "bad";
}) => (
  <span
    className={cn(
      "rounded-sm px-1.5 py-px font-mono text-[0.625rem] tracking-[0.06em]",
      tone === "muted" && "bg-sunk text-ink-2",
      tone === "mine" && "bg-accent-soft text-accent font-semibold",
      tone === "live" && "bg-sunk text-ok",
      tone === "bad" && "bg-sunk text-bad",
    )}
  >
    {children}
  </span>
);

export const Meta = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span className={cn("font-mono text-[0.6875rem] text-ink-3", className)}>{children}</span>
);

/** Absence, with a reason. An empty panel that only says "none" teaches nothing. */
export const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[0.75rem] text-ink-3">{children}</div>
);

/** Work in flight with nothing for the boss to do yet. */
export const Working = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center gap-2 py-3 text-[0.8125rem] text-ink-2">
    <i className="breathe size-1.5 rounded-full bg-ink-3" />
    {children}
  </div>
);

export const Input = ({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input
    className={cn(
      "w-full rounded-md border border-rule bg-paper px-2 py-1 text-[0.8125rem] text-ink",
      "placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent-soft",
      "transition-colors duration-150",
      className,
    )}
    {...rest}
  />
);

export const Textarea = ({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea
    className={cn(
      "w-full resize-y rounded-md border border-rule bg-paper px-2 py-1 font-mono text-[0.75rem] leading-relaxed text-ink",
      "placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent-soft",
      className,
    )}
    {...rest}
  />
);
