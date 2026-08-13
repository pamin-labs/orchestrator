import { cn } from "../lib/utils";

/**
 * shadcn's table, on our tokens.
 *
 * The scroll container is part of `Table` rather than something each caller
 * remembers: a table wide enough to need it was pushing the whole page into a
 * horizontal scroll below about 900px, and "remember to wrap it" is exactly the
 * kind of rule that gets forgotten at the third call site.
 */
export function Table({ className, min, ...rest }: React.TableHTMLAttributes<HTMLTableElement> & { min?: string }) {
  return (
    <div className="-mx-2 overflow-x-auto px-2">
      <table
        className={cn("w-full border-collapse text-[0.8125rem]", className)}
        style={min ? { minWidth: min } : undefined}
        {...rest}
      />
    </div>
  );
}

export const THead = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <thead {...p} />;
export const TBody = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} />;
export const TR = (p: React.HTMLAttributes<HTMLTableRowElement>) => <tr {...p} />;

export function TH({ className, num, ...rest }: React.ThHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return (
    <th
      className={cn(
        "border-b border-rule pb-1.5 pr-3 text-[0.6875rem] font-medium uppercase tracking-[0.07em] text-ink-3",
        // Only the last column may lose its gutter: zeroing it on every numeric
        // column ran "turn" into "当前动作", in the header and in the cells.
        num ? "text-right last:pr-0" : "text-left",
        className,
      )}
      {...rest}
    />
  );
}

export function TD({ className, num, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return (
    <td
      className={cn(
        "border-b border-rule-soft py-1.5 pr-3 align-top",
        num && "text-right font-mono text-[0.75rem] last:pr-0",
        className,
      )}
      {...rest}
    />
  );
}

/** A share-of-total bar. The cost view had this inline three times. */
export function Bar({ frac, tone, className }: { frac: number; tone?: "ink" | "warn" | "bad"; className?: string }) {
  return (
    <span className={cn("block h-1 w-full min-w-10 rounded-sm bg-rule", className)}>
      <i
        className={cn(
          "block h-full rounded-sm",
          tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : "bg-ink-3",
        )}
        style={{ width: `${Math.max(2, Math.min(1, frac) * 100)}%` }}
      />
    </span>
  );
}
