import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The type scale, told to the merger.
 *
 * `tailwind-merge` groups by prefix, so a name it has never heard of under
 * `text-` is filed as a *colour*. `text-meta` and `text-ink` then looked like
 * two colours and the later one won — the flame graph's labels silently lost
 * their size the moment the scale stopped being a rem literal, which the merger
 * could read on sight. Every token in `@theme` has to be declared here too.
 */
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["tag", "pill", "meta", "secondary", "body", "base", "name", "lead", "card", "title", "figure"] },
      ],
    },
  },
});

/**
 * Conditional class names, with later Tailwind utilities winning.
 *
 * Every primitive in this directory takes a `className` and has to let the caller
 * override what it sets by default; plain concatenation leaves both classes in the
 * list and lets specificity decide, which is how a `p-2` default silently beat a
 * caller's `p-4`.
 */
export const cn = (...v: ClassValue[]) => merge(clsx(v));
