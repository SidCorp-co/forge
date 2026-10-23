/**
 * What the issues kernel reads to keep an issue criterion's trace to a business criterion
 * (`issue_criteria.requirement_criterion_id`): the wordings of the issue's requirement a `(REQ-n BC-m)`
 * tag resolves against, and which traced wordings are still live proof. Served through the issues
 * kernel's ports, since a requirement is a domain the kernel does not import.
 */

import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { requirementCriteria, requirements } from '../db/schema-requirements.js';

export interface TraceWordings {
  /**
   * The issue's requirement, the revision its plan was written against (its current one where it
   * records none), and its current revision, the one coverage reads; null where it serves none.
   */
  requirement: { seq: number; revision: number | null; current: number | null } | null;
  wordings: {
    id: string;
    code: string;
    body: string;
    sinceRevision: number;
    retiredRevision: number | null;
  }[];
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
      body: requirementCriteria.body,
      sinceRevision: requirementCriteria.sinceRevision,
      retiredRevision: requirementCriteria.retiredRevision,
    })
    .from(requirementCriteria)
    .where(eq(requirementCriteria.requirementId, req.id));
  return {
    requirement: { seq: req.seq, revision: req.planned ?? req.current, current: req.current },
    wordings,
  };
}

/**
 * Of `ids`, each wording of the issue's own requirement whose BC the requirement still holds, by its
 * `REQ-n BC-m`: a trace at an earlier wording of a live BC is still that BC's proof, while a wording
 * of a BC the requirement retired, or of another requirement, is none to lose.
 */
export async function tracedCodesOf(
  tx: Tx,
  issueId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    SELECT rc.id, rc.code, r.req_seq
      FROM requirement_criteria rc
      JOIN requirements r ON r.id = rc.requirement_id
      JOIN issues i ON i.requirement_id = r.id
     WHERE i.id = ${issueId}
       AND rc.id IN (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
       AND EXISTS (SELECT 1 FROM requirement_criteria live
                    WHERE live.requirement_id = rc.requirement_id AND live.code = rc.code
                      AND live.retired_revision IS NULL)`)) as unknown as Array<{
    id: string;
    code: string;
    req_seq: number;
  }>;
  return new Map(rows.map((r) => [r.id, `REQ-${r.req_seq} ${r.code}`]));
}
