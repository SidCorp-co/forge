/**
 * What the issues kernel reads to keep an issue criterion's trace to a business criterion
 * (`issue_criteria.requirement_criterion_id`): the wordings of the issue's requirement a `(REQ-n BC-m)`
 * tag resolves against, and which traced wordings are still live proof. Served through the issues
 * kernel's ports, since a requirement is a domain the kernel does not import.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { requirementCriteria, requirements } from '../db/schema-requirements.js';

export interface TraceWordings {
  /** The issue's requirement, and the revision its plan was written against; null where it serves none. */
  requirement: { seq: number; revision: number | null } | null;
  wordings: { id: string; code: string; sinceRevision: number; retiredRevision: number | null }[];
}

export async function traceWordingsOf(tx: Tx, issueId: string): Promise<TraceWordings> {
  const [req] = await tx
    .select({
      id: requirements.id,
      seq: requirements.reqSeq,
      current: requirements.currentRevision,
      planned: issues.plannedRevision,
    })
    .from(issues)
    .innerJoin(requirements, eq(requirements.id, issues.requirementId))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!req) return { requirement: null, wordings: [] };
  const wordings = await tx
    .select({
      id: requirementCriteria.id,
      code: requirementCriteria.code,
      sinceRevision: requirementCriteria.sinceRevision,
      retiredRevision: requirementCriteria.retiredRevision,
    })
    .from(requirementCriteria)
    .where(eq(requirementCriteria.requirementId, req.id));
  return { requirement: { seq: req.seq, revision: req.planned ?? req.current }, wordings };
}

/** Of `ids`, the wordings of the issue's own requirement that are live, as `REQ-n BC-m`. */
export async function liveTracedCodesOf(
  tx: Tx,
  issueId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ code: requirementCriteria.code, reqSeq: requirements.reqSeq })
    .from(requirementCriteria)
    .innerJoin(requirements, eq(requirements.id, requirementCriteria.requirementId))
    .innerJoin(issues, eq(issues.requirementId, requirements.id))
    .where(
      and(
        eq(issues.id, issueId),
        inArray(requirementCriteria.id, [...ids]),
        isNull(requirementCriteria.retiredRevision),
      ),
    );
  return rows.map((r) => `REQ-${r.reqSeq} ${r.code}`).sort();
}
