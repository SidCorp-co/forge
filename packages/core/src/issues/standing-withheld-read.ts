/**
 * Why the admissible list withholds a takeable issue, asked of the gates that withhold it — the
 * dispatch policy, the design gate, the contract-wait gate, the pattern review, the scope another
 * live run holds — for the standing read and for the REST issue list, so the two cannot disagree
 * about one row. A gate the project's profile turns off withholds nothing here, as it withholds
 * nothing from the list (`devices/admissible.ts:enforced`, REQ-76).
 */

import type { GateId } from '@forge/contracts/gate-profiles';
import type { IssueStatus } from '@forge/contracts/issue-machine';
import { TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import type { IssueWithheld, IssueWithheldCode } from '@forge/contracts/issue-standing';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { scopeHeldSql } from '../db/schema-issue-designs.js';
import { contractHoldsOf, contractWaitUnsettledSql } from './contract-waits.js';
import { readIssueGates } from './gates.js';
import { scopeHoldsOf } from './issue-scope.js';
import { patternHoldsOf, patternReviewPendingSql } from './patterns.js';
import { designHoldsOf, designUnapprovedSql, policyGapsOf } from './ports.js';

/** A row with the four gate predicates already read. */
export interface GatedRow {
  id: string;
  status: IssueStatus;
  design_unapproved: boolean;
  contract_unsettled: boolean;
  pattern_pending: boolean;
  scope_held: boolean;
}

type GateFlag = 'design_unapproved' | 'contract_unsettled' | 'pattern_pending' | 'scope_held';

/** A gate's details, each under its code; only the scope hold names a holder besides. */
const said = (
  code: Exclude<IssueWithheldCode, 'ISSUE_SCOPE_HELD'>,
  details: Map<string, string>,
): Map<string, IssueWithheld> =>
  new Map([...details].map(([id, detail]) => [id, { code, detail }]));

/**
 * Each gate after the policy, in the order the admissible list asks them, with the flag its
 * predicate set on the row and the reader of its detail. The first that holds names the row.
 */
const GATES = [
  {
    gate: 'design_approved_for_build',
    flag: 'design_unapproved',
    holds: async (projectId, ids) =>
      said('WORKFLOW_DESIGN_NOT_APPROVED', await designHoldsOf(projectId, ids)),
  },
  {
    gate: 'contract_wait',
    flag: 'contract_unsettled',
    holds: async (projectId, ids) =>
      said('CONTRACT_WAIT_UNSETTLED', await contractHoldsOf(projectId, ids)),
  },
  {
    gate: 'patterns',
    flag: 'pattern_pending',
    holds: async (projectId, ids) =>
      said('PATTERN_REVIEW_PENDING', await patternHoldsOf(projectId, ids)),
  },
  {
    gate: 'scope_hold',
    flag: 'scope_held',
    holds: async (projectId, ids) =>
      new Map<string, IssueWithheld>(
        [...(await scopeHoldsOf(projectId, ids))].map(([id, h]) => [
          id,
          { code: 'ISSUE_SCOPE_HELD', detail: h.detail, holder: h.holder },
        ]),
      ),
  },
] as const satisfies readonly {
  gate: GateId;
  flag: GateFlag;
  holds: (projectId: string, ids: string[]) => Promise<Map<string, IssueWithheld>>;
}[];

/**
 * Why the admissible list withholds each takeable row, asked of the gates that withhold it (the
 * policy, then each of `GATES` the project's profile enforces), first that holds; a row that is not
 * withheld is absent. A gate is asked again only for the rows its predicate already held and no
 * earlier gate named, all of them in one read, so a page asks none and a page of held rows asks
 * each gate once.
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
  if (!ungapped.some((r) => GATES.some((g) => r[g.flag]))) return out;
  const modes = await readIssueGates(projectId);
  for (const { gate, flag, holds } of GATES) {
    if (modes[gate].mode !== 'enforce') continue;
    const asked = ungapped.filter((r) => r[flag] && !out.has(r.id)).map((r) => r.id);
    if (asked.length === 0) continue;
    for (const [id, withheld] of await holds(projectId, asked)) out.set(id, withheld);
  }
  return out;
}

/**
 * The same withholding for rows another read already holds (the REST issue list `forge next` ranks
 * from): one query for the four gate predicates over the takeable rows, then `withheldOf`. A row the
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
    scope_held: boolean;
  }>(
    await db.execute(sql`
      SELECT i.id,
             ${designUnapprovedSql(sql`i.id`)} AS design_unapproved,
             ${contractWaitUnsettledSql(sql`i.id`)} AS contract_unsettled,
             ${patternReviewPendingSql(sql`i.id`)} AS pattern_pending,
             ${scopeHeldSql(sql`i.id`)} AS scope_held
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
      scope_held: held.get(r.id)?.scope_held === true,
    })),
  );
}
