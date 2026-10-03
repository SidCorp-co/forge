import type { StandingTone } from "@forge/contracts/requirement-standing";
import { type ColorMeta, TONE_META } from "@/design/status";

type ToneColors = Omit<ColorMeta, "label">;

const violet = "var(--stage-triage)";

/** The badge legend's colours (`ux-review.html`): one meaning per colour on every requirement surface. */
export const TONE: Record<StandingTone, ToneColors> = {
  you: TONE_META.attention,
  run: TONE_META.active,
  ready: TONE_META.success,
  done: { fg: "var(--ink-600)", bg: "var(--paper-200)", dot: "var(--ink-500)" },
  err: TONE_META.failure,
  neutral: { fg: "var(--ink-600)", bg: "transparent", dot: "var(--ink-400)" },
  ai: { fg: "var(--wf-violet)", bg: `color-mix(in srgb, ${violet} 12%, transparent)`, dot: violet },
};

/** The tint an assistant's suggestion sits on, and its bar. */
export const AI_TINT = { bg: `color-mix(in srgb, ${violet} 10%, var(--bg-surface))`, bar: violet, fg: "var(--wf-violet)" };
