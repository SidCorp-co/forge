/**
 * Whether an issue's landing is an adoption record alone, and whether that record still holds
 * (REQ-5 BC-17, BC-18). The `merged` guard and the close read it here, so an issue whose links
 * moved off the version after its mark does not close as adopted.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { adoptionOnlyStamp } from './merge-mark-kind.js';
import { adoptionRecord } from './ports.js';

export interface AdoptionDelivery {
  /** The versions an adoption-only mark names; null where the mark is not one. */
  refs: string[] | null;
  /** Why the record no longer holds, where it does not. */
  shortfall: string | null;
}

export async function readAdoptionDelivery(
  executor: Pick<Db, 'select'>,
  issueId: string,
): Promise<AdoptionDelivery> {
  const [row] = await executor
    .select({
      projectId: issues.projectId,
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
      mergedLanding: issues.mergedLanding,
      mergedArtifacts: issues.mergedArtifacts,
      mergedPaths: issues.mergedPaths,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const refs = row
    ? adoptionOnlyStamp({ ...row, mergedArtifacts: row.mergedArtifacts ?? null })
    : null;
  if (!row || !refs) return { refs: null, shortfall: null };
  const read = await adoptionRecord(row.projectId, refs);
  return { refs, shortfall: read.ok ? null : read.detail };
}
