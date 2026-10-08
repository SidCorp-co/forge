import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirements } from '../db/schema-requirements.js';

/** The status and last change of the project's requirements among these sequences, for a memory naming them. */
export async function requirementStatusesBySeq(
  projectId: string,
  seqs: readonly number[],
): Promise<Map<number, { status: string; updatedAt: Date }>> {
  if (seqs.length === 0) return new Map();
  const rows = await db
    .select({
      reqSeq: requirements.reqSeq,
      status: requirements.status,
      updatedAt: requirements.updatedAt,
    })
    .from(requirements)
    .where(
      and(eq(requirements.projectId, projectId), inArray(requirements.reqSeq, [...new Set(seqs)])),
    );
  return new Map(rows.map((r) => [r.reqSeq, { status: r.status, updatedAt: r.updatedAt }]));
}
