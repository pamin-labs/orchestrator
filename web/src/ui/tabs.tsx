import * as T from "@radix-ui/react-tabs";
import { cn } from "./cn";

/**
 * shadcn's tabs, on our tokens.
 *
 * Used where the same kind of row has a state worth filtering by. Four stacked
 * sections read fine at four requirements and become a scroll hunt at forty — the
 * count belongs on the control that selects the list, not on a heading above it.
 */
export const Tabs = T.Root;

export function TabList({ className, ...rest }: React.ComponentProps<typeof T.List>) {
  return <T.List className={cn("flex flex-wrap gap-1 border-b border-rule", className)} {...rest} />;
}

export function Tab({
  className,
  count,
  mine,
  children,
  ...rest
}: React.ComponentProps<typeof T.Trigger> & {
  count?: number;
  /** Waiting on the boss: the one tone the accent is reserved for. */
  mine?: boolean;
}) {
  return (
    <T.Trigger
      className={cn(
        "-mb-px cursor-pointer border-b-2 border-transparent px-2.5 py-1.5 text-body text-ink-3",
        "transition-colors hover:text-ink data-[state=active]:border-accent data-[state=active]:font-medium",
        "data-[state=active]:text-ink",
        className,
      )}
      {...rest}
    >
      {children}
      {count != null && (
        <span
          className={cn(
            "ml-1.5 font-mono text-secondary",
            mine && count > 0 ? "font-semibold text-accent" : "text-ink-3",
          )}
        >
          {count}
        </span>
      )}
    </T.Trigger>
  );
}

export const TabPanel = ({ className, ...rest }: React.ComponentProps<typeof T.Content>) => (
  <T.Content className={cn("fade-in pt-4 focus:outline-none", className)} {...rest} />
);
