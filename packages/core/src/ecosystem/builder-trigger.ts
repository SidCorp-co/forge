/** A push to the branch a member project builds from reopens its builder runs (ISS-39, ISS-597). */

import type { Tx } from '../db/client.js';
import { emitEvent } from '../outbox/index.js';
import type { PushReading } from './builder-run-rules.js';
import { openOwedRun } from './link-service.js';
import { membershipsWhere } from './membership-store.js';

/** Opens the run a push owes in every ecosystem the project is an active member of; a reading that owes none opens nothing. */
export async function openPushedRuns(
  tx: Tx,
  input: { projectId: string; reading: PushReading },
): Promise<void> {
  const { projectId, reading } = input;
  if (reading.kind !== 'open') return;
  const active = (await membershipsWhere({ projectIds: [projectId] })).filter(
    (m) => m.state === 'active',
  );
  if (active.length === 0) return;
  for (const m of active) {
    await openOwedRun(tx, {
      ecosystemId: m.ecosystemId,
      projectId,
      trigger: reading.trigger,
      userId: m.decidedBy ?? m.invitedBy,
    });
  }
  // every active membership now holds an open run, opened here or before, so a redelivered push wakes the master whether or not this attempt opened it
  await emitEvent(tx, 'ecosystem.buildOwed', { projectId });
}
