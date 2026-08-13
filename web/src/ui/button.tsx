import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/**
 * One button shape for the whole panel. `go` is the primary action on a row,
 * `danger` is for anything that discards work, `quiet` is destructive-adjacent
 * but routine (打断, 封存).
 */
export const buttonStyles = cva(
  "inline-flex items-center gap-1.5 rounded-md border text-[0.8125rem] leading-tight whitespace-nowrap " +
    "transition-colors duration-150 ease-out-quint disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer",
  {
    variants: {
      variant: {
        default: "border-rule bg-paper text-ink-2 hover:text-ink hover:border-ink-3 active:bg-sunk",
        go: "border-accent bg-accent text-on-accent font-medium hover:brightness-110",
        danger: "border-bad bg-bad text-paper font-medium hover:brightness-110",
        quiet: "border-transparent bg-transparent text-ink-3 hover:text-ink hover:bg-sunk",
      },
      size: { default: "px-2.5 py-1", sm: "px-2 py-0.5 text-[0.75rem]" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonStyles>;

export function Button({ className, variant, size, ...rest }: ButtonProps) {
  return <button className={cn(buttonStyles({ variant, size }), className)} {...rest} />;
}

export function LinkButton({ className, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={cn(buttonStyles(), "no-underline", className)} target="_blank" rel="noreferrer" {...rest} />;
}
