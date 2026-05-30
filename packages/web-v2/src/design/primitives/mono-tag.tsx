import type { CSSProperties, ReactNode } from "react";

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
}

/** Monospace pill for IDs, branch names, run IDs, endpoints — never sentence-styled. */
export function MonoTag({ children, hue = "neutral", style }: MonoTagProps) {
  return (
    <span
      className="rounded-sm border font-mono font-semibold"
      style={{ fontSize: 11, padding: "2px 7px", ...HUES[hue], ...style }}
    >
      {children}
    </span>
  );
}
