import { cn } from "../lib/utils";

/**
 * Section label.
 *
 * Was 10px, uppercase, tracked out to 0.13em. Uppercase buys contrast in Latin and
 * nothing at all in Chinese, where it only widens the tracking of characters that
 * were already too small to read. 12px, normal case, ink-2.
 */
export const H2 = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <h2 className={cn("mb-2.5 text-[0.75rem] font-semibold tracking-[0.02em] text-ink-2", className)}>
    {children}
  </h2>
);

/** A sub-heading inside a view. The display face earns its place at ≥15px only. */
export const H3 = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <h3 className={cn("mt-8 mb-2.5 font-display text-[1rem] font-semibold", className)}>{children}</h3>
);

export const Meta = ({ children, className, ...rest }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn("font-mono text-[0.6875rem] text-ink-3", className)} {...rest}>
    {children}
  </span>
);

/** Absence, with a reason. An empty panel that only says "none" teaches nothing. */
export const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="max-w-[44rem] text-[0.75rem] leading-relaxed text-ink-3">{children}</div>
);

/** Work in flight with nothing for the boss to do yet. */
export const Working = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center gap-2 py-3 text-[0.8125rem] text-ink-2">
    <i className="breathe size-1.5 rounded-full bg-ink-3" />
    {children}
  </div>
);

const field =
  "w-full rounded-md border border-rule bg-paper text-ink placeholder:text-ink-3 " +
  "transition-colors duration-150 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent-soft";

export const Input = ({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input className={cn(field, "px-2 py-1 text-[0.8125rem]", className)} {...rest} />
);

export const Textarea = ({
  className,
  ref,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: React.Ref<HTMLTextAreaElement> }) => (
  <textarea
    ref={ref}
    className={cn(field, "resize-y px-2 py-1 font-mono text-[0.75rem] leading-relaxed", className)}
    {...rest}
  />
);
