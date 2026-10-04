import { FEEDBACK_UNTRIAGED_PHASES, type FeedbackPhase } from '@forge/contracts/feedback';
import type { NeedsYouArea } from '@forge/contracts/needs-you';
import { needsViewer, type Standing } from '@forge/contracts/standing';

/**
 * The rows a list puts in its waiting-on-you group, and what each owes the viewer, most frequent
 * first. The group is the list's own standing, so the count is the list's group size by construction.
 */
export function areaOf(rows: readonly Standing[]): NeedsYouArea {
  const tally = new Map<string, number>();
  let you = 0;
  for (const row of rows) {
    if (!needsViewer(row)) continue;
    you += 1;
    const act = row.waitingOn.act;
    tally.set(act, (tally.get(act) ?? 0) + 1);
  }
  const acts = [...tally]
    .map(([act, count]) => ({ act, count }))
    .sort((a, b) => b.count - a.count || a.act.localeCompare(b.act));
  return { you, acts };
}

const UNTRIAGED: ReadonlySet<FeedbackPhase> = new Set(FEEDBACK_UNTRIAGED_PHASES);

export const untriaged = (phase: FeedbackPhase): boolean => UNTRIAGED.has(phase);
