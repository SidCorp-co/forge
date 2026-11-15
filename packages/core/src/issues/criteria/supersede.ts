// A landed issue's criterion that a later issue changed on purpose, retired as superseded by it
// (REQ-48 BC-18, ISS-1240). agenfold FB-645: ISS-311 replaced ISS-228's cost-per-day chart on the
// owner's direction, a runtime re-judge on a later build failed ISS-228 criterion 1, and the fail
// reopened the long-closed issue; nothing could say the change was deliberate, so the master dropped
// it. Retiring the criterion is the whole fix: the verdict door and a BC fail's routing read live
// criteria only. The retired row names the later issue's criterion that now holds the promise
// (`issue_criteria.moved_to_criterion_id`, as a close's move does), and the reason is recorded on
// the issue's history, where the retired read and a refused verdict name it.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { ISSUE_RESOLVED_STATUSES } from '@forge/contracts/issue-machine';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { issueCriteria } from '../../db/schema-issue-criteria.js';
import { type Actor, recordActivityTx } from '../activity.js';
import { issueDisplayIds } from '../display-ids.js';
import { issueIdOfKey } from '../issue-route-ref.js';
import { renderCriteriaText } from './criteria-text.js';
import { type CriterionRef, criterionNamed } from './criterion-reword.js';
import { liveRows, lockIssue, refuseCriteria } from './store.js';

export const SUPERSEDED = 'issue.criterion.superseded';

/** Past the build: where a criterion's verdicts were earned and its wording is frozen. */
const LANDED: ReadonlySet<string> = new Set<IssueStatus>(ISSUE_RESOLVED_STATUSES);

export interface Superseded {
  criterionId: string;
  n: number;
  supersededBy: { issue: string; criterion: number };
  reason: string;
}

/** What a superseded criterion's history says: the later issue's key and criterion, and why. */
export interface SupersededBy {
  issue: string;
  criterion: number;
  reason: string;
  at: string;
}

const listed = (live: readonly { n: number }[]) =>
  live
    .map((r) => r.n)
    .sort((a, b) => a - b)
    .join(', ') || 'none';

/**
 * Retire criterion `ref` of a landed issue as superseded by criterion `criterion` of the later
 * landed issue `by`, in the caller's transaction; null where the issue is gone. Refused by name,
 * nothing written, for the issue itself, an issue of another project, either issue not landed, or a
 * criterion live on neither.
 */
export async function supersedeCriterionTx(
  tx: Tx,
  args: {
    issueId: string;
    ref: CriterionRef;
    by: string;
    criterion: number;
    reason: string;
    actor: Actor;
  },
): Promise<Superseded | null> {
  const issue = await lockIssue(tx, args.issueId);
  if (!issue) return null;
  if (!LANDED.has(issue.status)) {
    throw refuseCriteria(
      'CRITERION_SUPERSEDE_NOT_LANDED',
      `this issue is \`${issue.status}\`: a criterion is superseded only once its issue is past its build (awaiting_release or closed); before then, change its criteria with PUT /api/issues/:id/criteria`,
    );
  }
  const row = criterionNamed(await liveRows(tx, issue.id), args.ref);
  const [own] = await tx
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issue.id));
  const byId = own ? await issueIdOfKey(args.by, own.projectId) : null;
  const [later] = byId
    ? await tx
        .select({ id: issues.id, status: issues.status, projectId: issues.projectId })
        .from(issues)
        .where(eq(issues.id, byId))
    : [];
  if (!later || later.projectId !== own?.projectId) {
    throw refuseCriteria(
      'CRITERION_SUPERSEDE_BY_UNKNOWN',
      `\`${args.by}\` names no issue of this issue's project; name the later issue that changed what criterion ${row.n} promised by its key or id`,
      '/by',
    );
  }
  if (later.id === issue.id) {
    throw refuseCriteria(
      'CRITERION_SUPERSEDE_SELF',
      `an issue does not supersede its own criterion ${row.n}: correct its wording with PATCH /api/issues/:id/criteria/${row.n}, or name the later issue that changed it`,
      '/by',
    );
  }
  const laterKey = (await issueDisplayIds([later.id])).get(later.id) ?? later.id;
  if (!LANDED.has(later.status)) {
    throw refuseCriteria(
      'CRITERION_SUPERSEDE_BY_UNLANDED',
      `${laterKey} is \`${later.status}\`: what criterion ${row.n} promised changes only once ${laterKey} has landed (awaiting_release or closed); supersede it then`,
      '/by',
    );
  }
  const target = (await liveRows(tx, later.id)).find((r) => r.n === args.criterion);
  if (!target) {
    throw refuseCriteria(
      'CRITERION_UNKNOWN',
      `${laterKey} has no live criterion ${args.criterion}; its live criteria are ${listed(await liveRows(tx, later.id))}. Name the one that now holds what criterion ${row.n} promised`,
      '/criterion',
    );
  }
  const reason = args.reason.trim();
  await tx
    .update(issueCriteria)
    .set({ retiredAt: sql`now()`, movedToCriterionId: target.id })
    .where(and(eq(issueCriteria.id, row.id), isNull(issueCriteria.retiredAt)));
  const text = renderCriteriaText(
    (await liveRows(tx, issue.id))
      .sort((a, b) => a.position - b.position || a.n - b.n)
      .map(({ n, statement }) => ({ n, statement })),
  );
  await tx
    .update(issues)
    .set({ acceptanceCriteria: text === '' ? null : text, updatedAt: sql`now()` })
    .where(eq(issues.id, issue.id));
  await recordActivityTx(tx, {
    issueId: issue.id,
    actor: args.actor,
    action: SUPERSEDED,
    payload: {
      criterionId: row.id,
      n: row.n,
      statement: row.statement,
      byIssueId: later.id,
      by: laterKey,
      byCriterionId: target.id,
      byCriterion: target.n,
      reason,
    },
  });
  return {
    criterionId: row.id,
    n: row.n,
    supersededBy: { issue: laterKey, criterion: target.n },
    reason,
  };
}

/** Each criterion of `issueId` superseded by a later issue, by its row id: whom by, and why. */
export async function supersessionsOf(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
): Promise<Map<string, SupersededBy>> {
  const rows = (await executor.execute(sql`
    SELECT created_at, payload FROM activity_log
     WHERE issue_id = ${issueId}::uuid AND action = ${SUPERSEDED}
     ORDER BY created_at, id`)) as unknown as Array<{
    created_at: string | Date;
    payload: { criterionId: string; by: string; byCriterion: number; reason: string; n: number };
  }>;
  return new Map(
    rows.map((r) => [
      r.payload.criterionId,
      {
        issue: r.payload.by,
        criterion: r.payload.byCriterion,
        reason: r.payload.reason,
        at: new Date(r.created_at).toISOString(),
      },
    ]),
  );
}

/**
 * Why a verdict naming criterion `n` of `issueId` has nowhere to go, where a later issue superseded
 * it and no live criterion took its number since; null where nothing superseded it.
 */
export async function supersededVerdictDetail(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
  n: number,
): Promise<string | null> {
  const rows = (await executor.execute(sql`
    SELECT a.payload FROM activity_log a
      JOIN issue_criteria c ON c.id = (a.payload ->> 'criterionId')::uuid AND c.retired_at IS NOT NULL
     WHERE a.issue_id = ${issueId}::uuid AND a.action = ${SUPERSEDED}
       AND (a.payload ->> 'n')::int = ${n}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT 1`)) as unknown as Array<{
    payload: { by: string; byCriterion: number; reason: string };
  }>;
  const hit = rows[0];
  if (!hit) return null;
  const { by, byCriterion, reason } = hit.payload;
  return `criterion ${n} was superseded by ${by} criterion ${byCriterion} (${reason}): it is no longer this issue's to prove, and nothing judged here reopens it. Judge ${by} criterion ${byCriterion} instead.`;
}
