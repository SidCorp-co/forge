// cm:why the snapshot rides from the send route to the turn through process memory rather than a column:
// it is per-turn-volatile view state that is never persisted (turn-context.ts's rule), and a turn that
// finds none — another replica, a restart — answers without it rather than with a stale page.

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
