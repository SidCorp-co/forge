/**
 * What a deferred requirement reads back (ISS-85): the latest defer row, from where it left, why
 * and for which phase.
 */

import type { RequirementDeferral } from '@forge/contracts/requirements';
import { and, desc, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { requirementDeferrals } from '../db/schema-requirements.js';

/** The defer a deferred requirement stands on: from where, why and until when. */
export async function latestDeferOf(tx: Tx, requirementId: string) {
  const [row] = await tx
    .select()
    .from(requirementDeferrals)
    .where(
      and(
        eq(requirementDeferrals.requirementId, requirementId),
        eq(requirementDeferrals.act, 'defer'),
      ),
    )
    .orderBy(desc(requirementDeferrals.decidedAt))
    .limit(1);
  return row ?? null;
}

export async function deferralOf(
  requirementId: string,
  status: string,
): Promise<RequirementDeferral | null> {
  if (status !== 'deferred') return null;
  const row = await latestDeferOf(db, requirementId);
  if (!row || row.fromStatus === 'deferred') return null;
  return {
    from: row.fromStatus,
    reason: row.reason ?? '',
    targetPhase: row.targetPhase,
    deferredBy: row.decidedBy,
    deferredAt: row.decidedAt.toISOString(),
  };
}
