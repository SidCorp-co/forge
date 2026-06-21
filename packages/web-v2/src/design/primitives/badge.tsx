import type { ReactNode } from "react";
import { TONE_META } from "@/design/status";

type Tone = "neutral" | "accent" | "cobalt" | "green" | "red" | "amber";

// ISS-509 — the status-meaning tones resolve through the semantic-tone source of
// truth so these one-off badges can't drift from the system. `accent` (flame)
// stays a brand-accent badge, intentionally NOT a status tone.
const TONE: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: "var(--fg-muted)", bg: "var(--paper-100)" },
  accent: { fg: "var(--flame-700)", bg: "var(--flame-50)" },
  cobalt: { fg: TONE_META.active.fg, bg: TONE_META.active.bg },
  green: { fg: TONE_META.success.fg, bg: TONE_META.success.bg },
  red: { fg: TONE_META.failure.fg, bg: TONE_META.failure.bg },
  amber: { fg: TONE_META.attention.fg, bg: TONE_META.attention.bg },
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
