import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Tip } from "./tooltip";
import { cn } from "../lib/utils";

/**
 * Light / dark / follow the system.
 *
 * Three states, not two: "follow the system" is the one most people want and the
 * one a bare toggle cannot express — it silently pins whatever the machine
 * happened to be when you first clicked. The stored value is the preference; the
 * `data-theme` attribute is always resolved to a concrete light or dark, which is
 * why the stylesheet needs one dark block instead of three.
 */
type Pref = "system" | "light" | "dark";
const KEY = "orch.theme";
const NEXT: Record<Pref, Pref> = { system: "light", light: "dark", dark: "system" };
const ZH: Record<Pref, string> = { system: "跟随系统", light: "浅色", dark: "深色" };

const read = (): Pref => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
};

const apply = (p: Pref) => {
  const dark = p === "dark" || (p === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
};

export function ThemeToggle() {
  const [pref, setPref] = useState<Pref>(read);

  useEffect(() => {
    apply(pref);
    try {
      localStorage.setItem(KEY, pref);
    } catch {}
    if (pref !== "system") return;
    // On "system" the OS can change under us — at sunset, on a schedule — and the
    // page has to follow without a reload.
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  // Its own listener rather than a prop from the shell: the state it flips lives
  // here, and lifting it would be a second copy to keep in step.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== "l") return;
      e.preventDefault();
      setPref((p) => NEXT[p]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const Icon = pref === "system" ? Monitor : pref === "light" ? Sun : Moon;
  return (
    <Tip label={`主题：${ZH[pref]}，点一下切到${ZH[NEXT[pref]]} ⌘⇧L`}>
      <button
        onClick={() => setPref((p) => NEXT[p])}
        aria-label={`主题：${ZH[pref]}`}
        className={cn(
          "grid size-6.5 cursor-pointer place-items-center rounded-md text-ink-3",
          "transition-colors hover:bg-sunk hover:text-ink",
        )}
      >
        <Icon size={14} strokeWidth={1.75} />
      </button>
    </Tip>
  );
}
