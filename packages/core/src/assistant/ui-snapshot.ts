// process memory, never a column: per-turn view state is not persisted (turn-context.ts's rule).

import type { UiSnapshot } from '@forge/contracts/ui-actions';
import { describeUiSnapshot } from '@forge/contracts/ui-actions';

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

/** The page the person was on at their newest message, as the turn's page context, or null. */
export function uiSnapshotPageContext(conversationId: string): Record<string, unknown> | null {
  const s = latest.get(conversationId);
  if (!s) return null;
  return { sees: describeUiSnapshot(s), snapshot: s };
}
