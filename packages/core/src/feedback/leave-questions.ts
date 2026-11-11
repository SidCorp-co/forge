// A declined feedback item is gone for good, so every open question on it is void in the decline's
// own transaction with the decline's reason: the clarification asked of its reporter and the Steward's
// decisions about it alike, and the reporter's bell row for each resolves (ISS-1213).

import type { Tx } from '../db/client.js';
import { voidQuestionsOnLeave } from '../questions/index.js';
import type { FeedbackActor } from './read.js';

export async function voidQuestionsOnDecline(
  tx: Tx,
  row: { id: string; status: string },
  actor: FeedbackActor,
  reason: string | null,
): Promise<void> {
  await voidQuestionsOnLeave(tx, {
    item: { kind: 'feedback', id: row.id },
    fromStatus: row.status,
    toStatus: 'declined',
    reason,
    by: actor.userId,
    actor: { type: 'user', id: actor.userId, agency: actor.agency },
    source: 'feedback',
  });
}
