import type { CSSProperties, ReactNode } from "react";
import { ISSUE_KEY_IN_TEXT, UNBROKEN_KEY_CLASS, unbrokenKeys } from "@/lib/unbroken-keys";
import { cn } from "@/lib/utils/cn";

type Hue = "cobalt" | "flame" | "neutral";

const HUES: Record<Hue, CSSProperties> = {
  cobalt: { color: "var(--cobalt-700)", background: "var(--cobalt-50)", borderColor: "var(--cobalt-100)" },
  flame: { color: "var(--flame-700)", background: "var(--flame-50)", borderColor: "var(--flame-100)" },
  neutral: { color: "var(--fg-muted)", background: "var(--paper-50)", borderColor: "var(--border-default)" },
};

export interface MonoTagProps {
  children: ReactNode;
  hue?: Hue;
  style?: CSSProperties;
  className?: string;
  title?: string;
}

/** Monospace pill for IDs, branch names, run IDs, endpoints — never sentence-styled. An issue key in
 *  its text stays one token on every width. */
export function MonoTag({ children, hue = "neutral", style, className, title }: MonoTagProps) {
  const text = typeof children === "string" ? children : null;
  const wholeKey = text !== null && text.match(ISSUE_KEY_IN_TEXT)?.[0] === text;
  return (
    <span
      title={title}
      className={cn("rounded-sm border font-mono font-semibold", wholeKey && UNBROKEN_KEY_CLASS, className)}
      style={{ fontSize: "var(--text-11)", padding: "2px 7px", ...HUES[hue], ...style }}
    >
      {text !== null && !wholeKey ? unbrokenKeys(text) : children}
    </span>
  );
}
