import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Conditional class names, with later Tailwind utilities winning.
 *
 * Every primitive in this directory takes a `className` and has to let the caller
 * override what it sets by default; plain concatenation leaves both classes in the
 * list and lets specificity decide, which is how a `p-2` default silently beat a
 * caller's `p-4`.
 */
export const cn = (...v: ClassValue[]) => twMerge(clsx(v));
