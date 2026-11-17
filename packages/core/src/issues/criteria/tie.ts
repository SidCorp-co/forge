// Tying an issue to business criteria of its requirement: the act
// `POST /api/issues/:id/criteria/traces` takes, matched by wording as coverage matches it.

import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { issueCriteria } from '../../db/schema-issue-criteria.js';
import { type Actor, recordActivityTx } from '../activity.js';
import { traceWordingsOf } from '../ports.js';
import { renderCriteriaText } from './criteria-text.js';
import { REWORDED } from './criterion-reword.js';
import { failureOwnedElsewhere } from './fail-owner.js';
import { liveRows, lockIssue, refuseCriteria } from './store.js';
import { planAdds, planTies } from './tie-plan.js';

const BC_CODE = /^BC-[1-9]\d*$/u;

/** What the door takes: existing lines tied by number, and codes added as lines of their own. */
export interface TraceInput {
  readonly ties: ReadonlyArray<{ n: number; code: string }>;
  readonly codes: readonly string[];
}

function refuseShapes(input: TraceInput): void {
  if (input.ties.length === 0 && input.codes.length === 0) {
    throw refuseCriteria(
      'CRITERIA_INPUT_INVALID',
      'send `ties: [{ n, code }]` to tie existing criteria by number, or `codes` to add a criterion per code',
      '',
    );
  }
  const sent = [
    ...input.ties.map((t, at) => ({ code: t.code, path: `/ties/${at}/code` })),
    ...input.codes.map((code) => ({ code, path: '/codes' })),
  ];
  const malformed = sent.find(({ code }) => !BC_CODE.test(code));
  if (malformed) {
    throw refuseCriteria(
      'CRITERIA_TRACE_INVALID',
      `\`${malformed.code}\` is not a business criterion code; send each as \`BC-<n>\`, as the requirement numbers them`,
      malformed.path,
    );
  }
  const twice = sent.find(({ code }, at) => sent.findIndex((s) => s.code === code) !== at);
  if (twice)
    throw refuseCriteria('CRITERIA_INPUT_INVALID', `${twice.code} is sent twice`, twice.path);
  const line = input.ties.find((t, at) => input.ties.findIndex((u) => u.n === t.n) !== at);
  if (line)
    throw refuseCriteria('CRITERIA_INPUT_INVALID', `criterion ${line.n} is tied twice`, '/ties');
}

/**
 * Tie an issue to business criteria of its requirement, each code resolved to its wording live at
 * the requirement's current revision (as `requirements/standing.ts:coverageOf` matches them). A tie
 * `{ n, code }` traces the existing live line n to it: the line keeps its id and every verdict on it,
 * its words open with the tag, and the change is on its wording history. A code in `codes` becomes a
 * new line worded as the BC; one a live line traces at an earlier wording is refreshed (that line is
 * retired and re-added under its number, its verdicts left on the retired row, the reword rule
 * `applyCriteria` follows). Taken at every status but `dropped`: a closed issue is tied to what it
 * delivered so its shipped work can be judged against it. Wrong input is refused by name before
 * anything is written (`tie-plan.ts`), and an add a live line already words is sent to the tie.
 */
export async function tieTracedCriteria(
  tx: Tx,
  issueId: string,
  input: TraceInput,
  actor: Actor,
): Promise<boolean> {
  const issue = await lockIssue(tx, issueId);
  if (!issue) return false;
  const path = input.ties.length > 0 ? '/ties' : '/codes';
  if (issue.status === 'dropped') {
    throw refuseCriteria(
      'CRITERIA_LOCKED',
      'this issue is `dropped`: it delivers nothing, so no business criterion is tied to it; reopen it first',
      path,
    );
  }
  refuseShapes(input);
  const { requirement: req, wordings } = await traceWordingsOf(tx, issueId);
  if (!req) {
    throw refuseCriteria(
      'CRITERIA_TRACE_UNRESOLVED',
      'this issue serves no requirement: link it to the requirement it delivers first',
      path,
    );
  }
  const rows = await liveRows(tx, issueId);
  const ties = planTies(rows, wordings, req, input.ties);
  const adds = planAdds(rows, wordings, req, input.codes);
  const taken = [...ties, ...adds].map((c) => c.requirementCriterionId);
  const owned = await failureOwnedElsewhere(tx, issueId, taken);
  if (owned) throw refuseCriteria('CRITERION_FAILURE_OWNED', owned, path);

  for (const t of ties) {
    await tx
      .update(issueCriteria)
      .set({ statement: t.statement, requirementCriterionId: t.requirementCriterionId })
      .where(and(eq(issueCriteria.id, t.row.id), eq(issueCriteria.issueId, issueId)));
    await recordActivityTx(tx, {
      issueId,
      actor,
      action: REWORDED,
      payload: {
        criterionId: t.row.id,
        n: t.row.n,
        before: t.row.statement,
        after: t.statement,
        reason: `tied to REQ-${req.seq} ${t.code}, keeping its verdicts`,
      },
    });
  }
  const refreshed = new Set(adds.flatMap((a) => a.refreshes ?? []));
  for (const id of refreshed) {
    await tx.update(issueCriteria).set({ retiredAt: sql`now()` }).where(eq(issueCriteria.id, id));
  }
  for (const { refreshes: _, ...c } of adds)
    await tx.insert(issueCriteria).values({ issueId, ...c });
  const tied = new Map(ties.map((t) => [t.row.id, t.statement]));
  const text = renderCriteriaText(
    [
      ...rows
        .filter((r) => !refreshed.has(r.id))
        .map((r) => ({ ...r, statement: tied.get(r.id) ?? r.statement })),
      ...adds,
    ]
      .sort((a, b) => a.n - b.n)
      .map(({ n, statement }) => ({ n, statement: statement.trim() })),
  );
  await tx.update(issues).set({ acceptanceCriteria: text }).where(eq(issues.id, issueId));
  return true;
}
