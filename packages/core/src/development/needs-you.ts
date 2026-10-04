import { FEEDBACK_UNTRIAGED_PHASES, type FeedbackPhase } from '@forge/contracts/feedback';
import type { NeedsYouArea } from '@forge/contracts/needs-you';

/**
 * The rows a list puts in its waiting-on-you group, and what each owes the viewer, most frequent
 * first. `isYou` is the list's own grouping, so the count is the list's group size by construction.
 */
export function areaOf<T>(
  rows: readonly T[],
  isYou: (row: T) => boolean,
  actOf: (row: T) => string,
): NeedsYouArea {
  const tally = new Map<string, number>();
  let you = 0;
  for (const row of rows) {
    if (!isYou(row)) continue;
    you += 1;
    const act = actOf(row);
    tally.set(act, (tally.get(act) ?? 0) + 1);
  }
  const acts = [...tally]
    .map(([act, count]) => ({ act, count }))
    .sort((a, b) => b.count - a.count || a.act.localeCompare(b.act));
  return { you, acts };
}

const UNTRIAGED: ReadonlySet<FeedbackPhase> = new Set(FEEDBACK_UNTRIAGED_PHASES);

export const untriaged = (phase: FeedbackPhase): boolean => UNTRIAGED.has(phase);
