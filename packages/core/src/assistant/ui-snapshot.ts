// process memory, never a column: per-turn view state is not persisted (turn-context.ts's rule).

import type { UiSnapshot } from '@forge/contracts/ui-actions';

const CAP = 2000;
const latest = new Map<string, UiSnapshot>();

export function rememberUiSnapshot(conversationId: string, snapshot: UiSnapshot): void {
  latest.delete(conversationId);
  latest.set(conversationId, snapshot);
  if (latest.size > CAP) {
    const oldest = latest.keys().next().value;
    if (oldest !== undefined) latest.delete(oldest);
  }
}

/** The page the person was on at their newest message, or null; `page-item.ts` makes it the turn's page context. */
export function latestUiSnapshot(conversationId: string): UiSnapshot | null {
  return latest.get(conversationId) ?? null;
}
