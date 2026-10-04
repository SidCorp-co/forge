import { and, asc, desc, eq, lte } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { mockups } from '../db/schema-mockups.js';
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

// cm:why a baseline pins every accepted mockup proposed against its revision or an earlier one,
// beside the designs (ISS-78): a mockup's bytes never change, so the pin is the row
export async function acceptedMockupIds(
  tx: Tx,
  requirementId: string,
  revision: number,
): Promise<string[]> {
  const rows = await tx
    .select({ id: mockups.id })
    .from(mockups)
    .where(
      and(
        eq(mockups.requirementId, requirementId),
        eq(mockups.status, 'accepted'),
        lte(mockups.revision, revision),
      ),
    )
    .orderBy(asc(mockups.mockupSeq));
  return rows.map((r) => r.id);
}
