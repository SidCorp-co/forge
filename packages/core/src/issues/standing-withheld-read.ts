/**
 * Why the admissible list withholds a takeable issue, asked of the gates that withhold it — the
 * dispatch policy, the design gate, the contract-wait gate, the pattern review — for the standing read and for the
 * REST issue list, so the two cannot disagree about one row.
 */

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import type { IssueWithheld } from '@forge/contracts/issue-standing';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { contractHoldsOf, contractWaitUnsettledSql } from './contract-waits.js';
import { patternHoldsOf, patternReviewPendingSql } from './patterns.js';
import { designHoldsOf, designUnapprovedSql, policyGapsOf } from './ports.js';

/** A row with the three gate predicates already read. */
export interface GatedRow {
  id: string;
  status: IssueStatus;
  design_unapproved: boolean;
  contract_unsettled: boolean;
  pattern_pending: boolean;
}

/**
 * Why the admissible list withholds each takeable row, asked of the gates that withhold it (the
 * policy, the design gate, the contract-wait gate, the pattern review), first that holds; a row that is not withheld is
 * absent. A gate is asked again only for the rows its predicate already held, all of them in one
 * read, so a page asks none and a page of held rows asks each gate once.
 */
export async function withheldOf(
  projectId: string,
  raws: readonly GatedRow[],
): Promise<Map<string, IssueWithheld>> {
  const out = new Map<string, IssueWithheld>();
  const takeable = raws.filter((r) => TAKEABLE_STATUSES.includes(r.status));
  if (takeable.length === 0) return out;
  const gapOf = await policyGapsOf(projectId);
  const ungapped: GatedRow[] = [];
  for (const r of takeable) {
    const gap = gapOf(r.status);
    if (gap) out.set(r.id, gap);
    else ungapped.push(r);
  }
  const designs = await designHoldsOf(
    projectId,
    ungapped.filter((r) => r.design_unapproved).map((r) => r.id),
  );
  for (const [id, detail] of designs) out.set(id, { code: 'WORKFLOW_DESIGN_NOT_APPROVED', detail });
  const contracts = await contractHoldsOf(
    projectId,
    ungapped.filter((r) => r.contract_unsettled && !designs.has(r.id)).map((r) => r.id),
  );
  for (const [id, detail] of contracts) out.set(id, { code: 'CONTRACT_WAIT_UNSETTLED', detail });
  const patterns = await patternHoldsOf(
    projectId,
    ungapped
      .filter((r) => r.pattern_pending && !designs.has(r.id) && !contracts.has(r.id))
      .map((r) => r.id),
  );
  for (const [id, detail] of patterns) out.set(id, { code: 'PATTERN_REVIEW_PENDING', detail });
  return out;
}

/**
 * The same withholding for rows another read already holds (the REST issue list `forge next` ranks
 * from): one query for the three gate predicates over the takeable rows, then `withheldOf`. A row the
 * admissible list leaves out says why on the list too, so no reader ranks an issue every dispatch
 * door refuses.
 */
export async function withheldAmong(
  projectId: string,
  rows: readonly { id: string; status: IssueStatus }[],
): Promise<Map<string, IssueWithheld>> {
  const takeable = rows.filter((r) => TAKEABLE_STATUSES.includes(r.status));
  if (takeable.length === 0) return new Map();
  const flags = rowsOf<{
    id: string;
    design_unapproved: boolean;
    contract_unsettled: boolean;
    pattern_pending: boolean;
  }>(
    await db.execute(sql`
      SELECT i.id,
             ${designUnapprovedSql(sql`i.id`)} AS design_unapproved,
             ${contractWaitUnsettledSql(sql`i.id`)} AS contract_unsettled,
             ${patternReviewPendingSql(sql`i.id`)} AS pattern_pending
        FROM issues i
       WHERE i.project_id = ${projectId} AND i.id IN (${idList(takeable.map((r) => r.id))})
    `),
  );
  const held = new Map(flags.map((f) => [f.id, f]));
  return withheldOf(
    projectId,
    takeable.map((r) => ({
      id: r.id,
      status: r.status,
      design_unapproved: held.get(r.id)?.design_unapproved === true,
      contract_unsettled: held.get(r.id)?.contract_unsettled === true,
      pattern_pending: held.get(r.id)?.pattern_pending === true,
    })),
  );
}
