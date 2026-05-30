import type { ReactNode } from "react";

type Tone = "neutral" | "accent" | "cobalt" | "green" | "red" | "amber";

const TONE: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: "var(--fg-muted)", bg: "var(--paper-100)" },
  accent: { fg: "var(--flame-700)", bg: "var(--flame-50)" },
  cobalt: { fg: "var(--cobalt-700)", bg: "var(--cobalt-50)" },
  green: { fg: "var(--green-600)", bg: "var(--green-50)" },
  red: { fg: "var(--red-600)", bg: "var(--red-50)" },
  amber: { fg: "var(--amberw-600)", bg: "var(--amberw-50)" },
};

export interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
}

/** Small count / label pill (e.g. unread counts, "12 open"). For run status
    use StatusChip; for IDs use MonoTag. */
export function Badge({ children, tone = "neutral" }: BadgeProps) {
  const t = TONE[tone];
  return (
    <span
      className="inline-flex min-w-[18px] items-center justify-center rounded-pill px-1.5 font-semibold"
      style={{ fontSize: 11, lineHeight: "16px", color: t.fg, background: t.bg }}
    >
      {children}
    </span>
  );
}
