// How long an item has waited, as a chip whose weight rises with the wait: plain under a day, tinted
// to three days, bold with a ring to fourteen, and red past that. The number is already in the data;
// this is what makes it be seen.

import { Icon } from "@/design";
import { TONE_META, type SemanticTone } from "@/design/status";
import { formatElapsed } from "@/features/overview/derive";
import { type AgeBand, ageBand, secondsSince } from "../shape";

const BAND: Record<AgeBand, { tone: SemanticTone | null; weight: string; ring: boolean }> = {
  fresh: { tone: null, weight: "font-normal", ring: false },
  aging: { tone: "attention", weight: "font-medium", ring: false },
  stale: { tone: "attention", weight: "font-semibold", ring: true },
  overdue: { tone: "failure", weight: "font-bold", ring: true },
};

export function AgeChip({ since, now }: { since: string | undefined; now: number }) {
  const seconds = secondsSince(since, now);
  if (seconds === null) return null;
  const band = ageBand(seconds);
  const b = BAND[band];
  const meta = b.tone ? TONE_META[b.tone] : null;
  const age = formatElapsed(seconds);
  return (
    <span
      data-testid="age-chip"
      data-band={band}
      title={`Waiting ${age}.`}
      className={`inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-pill px-1.5 py-0.5 tabular-nums ${b.weight} ${meta ? "" : "text-subtle"}`}
      style={{
        fontSize: "var(--text-11)",
        ...(meta ? { color: meta.fg, background: meta.bg } : {}),
        ...(meta && b.ring ? { boxShadow: `inset 0 0 0 1px ${meta.dot}` } : {}),
      }}
    >
      {band === "overdue" && <Icon name="alert" size={11} />}
      {age}
    </span>
  );
}
