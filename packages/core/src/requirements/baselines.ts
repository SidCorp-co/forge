import { and, desc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { requirementBaselinePins, requirementBaselines } from '../db/schema-requirements.js';

// cm:why an agree writes seq 1 and each re-pin a further seq of the same revision, so the latest
// baseline of a revision is the highest seq there (ISS-86)
export async function latestBaselineIn(tx: Tx, requirementId: string, revision: number) {
  const [b] = await tx
    .select({ seq: requirementBaselines.seq, readiness: requirementBaselines.readiness })
    .from(requirementBaselines)
    .where(
      and(
        eq(requirementBaselines.requirementId, requirementId),
        eq(requirementBaselines.revision, revision),
      ),
    )
    .orderBy(desc(requirementBaselines.seq))
    .limit(1);
  if (!b) return null;
  const pins = await tx
    .select()
    .from(requirementBaselinePins)
    .where(
      and(
        eq(requirementBaselinePins.requirementId, requirementId),
        eq(requirementBaselinePins.revision, revision),
        eq(requirementBaselinePins.baselineSeq, b.seq),
      ),
    );
  return { seq: b.seq, readiness: b.readiness, pins };
}

export async function plannedBaselineSeqIn(
  tx: Tx,
  requirementId: string,
  revision: number | null,
): Promise<number | null> {
  if (revision === null) return null;
  return (await latestBaselineIn(tx, requirementId, revision))?.seq ?? null;
}
