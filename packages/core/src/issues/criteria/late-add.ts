// ISS-1080 — criteria added once past the lock. An issue that reached `awaiting_release` (or
// `closed`) with no criteria on the record had nothing a verdict could attach to, and the lock
// (`store.ts:applyCriteria`) refused putting them there: epod ISS-97 took a reopen round-trip that
// read in its history as a defect. The run holding such an issue adds them once, without a reopen,
// and the add is recorded as one made after landing (`issue.criteria.added_after_landing`, its actor
// and time on the activity row). An issue that has, or had, criteria stays locked.

import type { CriteriaRefusalCode } from '@forge/contracts/issues';
import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { refuser } from '../../lib/refusal.js';
import { type Actor, recordActivityTx } from '../activity.js';
import type { CallerBox } from '../caller-box.js';
import { callerHolds, holderSentence, runHoldersOf } from '../run-holder.js';

const refuse = refuser<CriteriaRefusalCode>('CRITERIA_REFUSED');

export const ADDED_AFTER_LANDING = 'issue.criteria.added_after_landing';

/** Who writes criteria: the actor recorded on the add, and the box a holder is read against. */
export interface CriteriaWriter {
  readonly actor: Actor;
  readonly box: CallerBox | null;
}

/** What the lock does with a change to an issue's criteria at a locked status. */
export type LockReading =
  | { readonly kind: 'late-add'; readonly holder: string }
  | { readonly kind: 'locked'; readonly detail: string };

const reopenDoor =
  'reopen it to change them, or correct one wording with PATCH /api/issues/:id/criteria/:n, which keeps its verdicts';

/**
 * At a locked status: the one add after landing, where the issue is at `awaiting_release` or
 * `closed`, has never had a criterion on the record, and the writer's box holds it
 * (`run-holder.ts:callerHolds`); otherwise the lock, with why. A second add is refused
 * CRITERIA_LATE_ADD_SPENT, and an add by anyone but the holder CRITERIA_LATE_ADD_NOT_HOLDER.
 */
export async function lockReading(
  tx: Tx,
  issue: { id: string; status: string },
  writer: CriteriaWriter | null,
  path: string,
): Promise<LockReading> {
  const lockedAt = `this issue is at \`${issue.status}\``;
  if (issue.status === 'dropped') {
    return {
      kind: 'locked',
      detail: `${lockedAt}, where its criteria are the ones its verdicts were earned on; ${reopenDoor}`,
    };
  }
  const [spent] = (await tx.execute(sql`
    SELECT created_at, actor_type, actor_id FROM activity_log
     WHERE issue_id = ${issue.id} AND action = ${ADDED_AFTER_LANDING}
     ORDER BY created_at, id LIMIT 1`)) as unknown as Array<{
    created_at: Date | string;
    actor_type: string;
    actor_id: string;
  }>;
  if (spent) {
    throw refuse(
      'CRITERIA_LATE_ADD_SPENT',
      `${lockedAt}, and its criteria were already added after landing, once, by ${spent.actor_type} ${spent.actor_id} at ${new Date(spent.created_at).toISOString()}: that add is taken once per issue. To change them now, ${reopenDoor}`,
      path,
    );
  }
  const [had] = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM issue_criteria WHERE issue_id = ${issue.id}`)) as unknown as Array<{
    n: number;
  }>;
  if ((had?.n ?? 0) > 0) {
    return {
      kind: 'locked',
      detail: `${lockedAt}, where its criteria are the ones its verdicts were earned on; ${reopenDoor}. Criteria are added after landing only to an issue that never had any on the record`,
    };
  }
  const holders = await runHoldersOf(tx, issue);
  if (!writer?.box || !callerHolds(holders, writer.box)) {
    const held =
      holders.length > 0 ? `${holders.map(holderSentence).join(' and ')} holds it` : 'no run holds it';
    throw refuse(
      'CRITERIA_LATE_ADD_NOT_HOLDER',
      `${lockedAt} with no criteria on the record, and the one add after landing is the move of the run holding it: ${held}, and this caller is not that run's box or the token that wrote its lease. Add them from the holding run, or claim it first by writing its lease (PATCH /api/issues/${issue.id} with \`sessionContext.lease\`)`,
      path,
    );
  }
  const holder = holders.find((h) => callerHolds([h], writer.box));
  return { kind: 'late-add', holder: holder ? holderSentence(holder) : 'the caller' };
}

/** The add after landing on the issue's history: by whom (the activity's actor), when, and what. */
export async function recordAddedAfterLanding(
  tx: Tx,
  issue: { id: string; status: string },
  writer: CriteriaWriter,
  added: readonly number[],
  holder: string,
): Promise<void> {
  await recordActivityTx(tx, {
    issueId: issue.id,
    actor: writer.actor,
    action: ADDED_AFTER_LANDING,
    payload: { status: issue.status, added: [...added], holder },
  });
}
