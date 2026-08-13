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
        num ? "pr-0 text-right" : "text-left",
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
        num && "pr-0 text-right font-mono text-[0.75rem]",
        className,
      )}
      {...rest}
    />
  );
}

/** A share-of-total bar. The cost view had this inline three times. */
export function Bar({ frac, tone }: { frac: number; tone?: "ink" | "warn" | "bad" }) {
  return (
    <span className="block h-1 min-w-12 rounded-sm bg-rule">
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
