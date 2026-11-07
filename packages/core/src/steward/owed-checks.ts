// The checks the standing sweep starts (REQ-67, ISS-1084): a requirement's delivery waits on the
// steward's check while the steward is on, and the check starts on its agree and on each breakdown.
// One that ended without finishing, or never ran, was owed for ever: nothing raised it again
// (adminhub-api REQ-22, owed since its 2026-11-06 agree; forge REQ-45 r8). Each such requirement gets
// its check queued as the handoff that owed it, `requirement.agreed`, folded under the steward's own
// run lock, and the move's refusal says when (`requirements/delivery-check.ts:deliveryCheckRefusals`).
// It is a handoff, so the sweep's room never holds it (ISS-1100: forge REQ-45 and agenfold REQ-18 were
// owed all day once stuck diagnoses had spent the sweep's share): it spends the handoff share and
// whatever the day has left, and where the day cannot pay for it, it is queued due when the budget
// resumes, which its refusal names.

import { STEWARD_TRIGGER_ACT } from '@forge/contracts/steward';
import { db } from '../db/client.js';
import { checksOwedIn } from '../requirements/index.js';
import { costOf, fits, nextUtcDay, stewardStanceOf, utcDayStart } from './policy.js';
import { foldTrigger, spentSince } from './runs-store.js';

const TRIGGER = 'requirement.agreed' as const;

/**
 * Queue the check of each agreed requirement of `projectId` owed one and taking none, oldest agreed
 * first; how many were queued. Those the day's budget has room for are due after the debounce, the
 * rest when the budget resumes (`nextUtcDay`). The run's event names the sweep, since no outbox event
 * carried it.
 */
export async function raiseOwedChecks(projectId: string, now: Date): Promise<number> {
  const owed = await checksOwedIn(projectId, now);
  if (owed.length === 0) return 0;
  const { budget } = await stewardStanceOf(projectId);
  const spent = await spentSince(projectId, utcDayStart(now));
  const cost = costOf([STEWARD_TRIGGER_ACT[TRIGGER]]);
  for (const [i, req] of owed.entries()) {
    const taken = {
      gatewayTurns: spent.gatewayTurns + i * cost.gatewayTurns,
      runnerJobs: spent.runnerJobs + i * cost.runnerJobs,
    };
    await db.transaction((tx) =>
      foldTrigger(tx, {
        projectId,
        subject: { kind: 'requirement', id: req.id, key: req.key },
        trigger: TRIGGER,
        outboxId: `sweep:check-owed:${req.id}:${now.getTime()}`,
        at: now,
        ...(fits(budget, taken, cost) ? {} : { dueAt: nextUtcDay(now) }),
      }),
    );
  }
  return owed.length;
}
