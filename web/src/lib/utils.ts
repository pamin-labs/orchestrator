import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

export const money = (n?: number | null) => `$${(n ?? 0).toFixed(2)}`;
export const K = (n?: number | null) => ((n ?? 0) >= 1000 ? `${Math.round((n ?? 0) / 1000)}k` : String(n ?? 0));
export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const waited = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "刚刚" : m < 60 ? `等待 ${m}m` : `等待 ${Math.round(m / 60)}h`;
};
