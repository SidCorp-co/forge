import { and, eq, inArray, or } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';

/** The project's issues among these ids and sequences, for a screen checking what a message cites. */
export async function citedIssues(
  projectId: string,
  cited: { readonly ids: readonly string[]; readonly seqs: readonly number[] },
  tx: Tx,
) {
  const conds = [
    ...(cited.ids.length > 0 ? [inArray(issues.id, [...cited.ids])] : []),
    ...(cited.seqs.length > 0 ? [inArray(issues.issSeq, [...cited.seqs])] : []),
  ];
  if (conds.length === 0) return [];
  return tx
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      status: issues.status,
      mergedAt: issues.mergedAt,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), or(...conds)));
}
