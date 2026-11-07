// The checks the standing sweep starts (REQ-67, ISS-1084): a requirement's delivery waits on the
// steward's check while the steward is on, and the check starts on its agree and on each breakdown.
// One that ended without finishing, or never ran, was owed for ever: nothing raised it again
// (adminhub-api REQ-22, owed since its 2026-11-06 agree; forge REQ-45 r8). Each such requirement gets
// its check queued as the handoff that owed it, `requirement.agreed`, folded under the steward's own
// run lock, and the move's refusal says when (`requirements/delivery-check.ts:deliveryCheckRefusals`).

import { db } from '../db/client.js';
import { checksOwedIn } from '../requirements/index.js';
import { foldTrigger } from './runs-store.js';

/**
 * Queue the check of each agreed requirement of `projectId` owed one and taking none, at most `room`
 * of them, oldest agreed first; how many were queued. The run's event names the sweep, since no
 * outbox event carried it.
 */
export async function raiseOwedChecks(projectId: string, now: Date, room: number): Promise<number> {
  const owed = await checksOwedIn(projectId, now, room);
  for (const req of owed) {
    await db.transaction((tx) =>
      foldTrigger(tx, {
        projectId,
        subject: { kind: 'requirement', id: req.id, key: req.key },
        trigger: 'requirement.agreed',
        outboxId: `sweep:check-owed:${req.id}:${now.getTime()}`,
        at: now,
      }),
    );
  }
  return owed.length;
}
