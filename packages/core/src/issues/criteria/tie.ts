// Tying an issue to business criteria of its requirement from its Criteria tab: the act
// `POST /api/issues/:id/criteria/traces` takes, matched by wording as coverage matches it.

import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { issueCriteria } from '../../db/schema-issue-criteria.js';
import { traceWordingsOf } from '../ports.js';
import { renderCriteriaText } from './criteria-text.js';
import { liveRows, liveWordingAt, lockIssue, refuseCriteria } from './store.js';

const BC_CODE = /^BC-[1-9]\d*$/u;

/**
 * Tie an issue to business criteria of its requirement, matched by wording as coverage matches it
 * (`requirements/standing.ts:coverageOf`): each code resolves to its wording live at the
 * requirement's current revision. A code no live criterion of the issue traces becomes one new
 * criterion, worded as the BC and traced to that wording. A code a live criterion traces at an
 * earlier wording is refreshed: that criterion is retired and re-added under its own number, worded
 * and traced as the BC is now, so the verdicts it earned stay on the retired row and none counts for
 * the new wording until it is judged again (the reword rule `applyCriteria` follows). It never drops
 * a criterion, and it is taken at every status but `dropped`: a closed issue is tied to what it
 * delivered so its shipped work can be judged against it. A code that is not `BC-<n>`, names no live
 * wording, is sent twice, or is already traced at its current wording by a live criterion of this
 * issue is refused by name, and nothing is written.
 */
export async function appendTracedCriteria(
  tx: Tx,
  issueId: string,
  codes: readonly string[],
): Promise<boolean> {
  const issue = await lockIssue(tx, issueId);
  if (!issue) return false;
  if (issue.status === 'dropped') {
    throw refuseCriteria(
      'CRITERIA_LOCKED',
      'this issue is `dropped`: it delivers nothing, so no business criterion is tied to it; reopen it first',
      '/codes',
    );
  }
  const malformed = codes.find((code) => !BC_CODE.test(code));
  if (malformed !== undefined) {
    throw refuseCriteria(
      'CRITERIA_TRACE_INVALID',
      `\`${malformed}\` is not a business criterion code; send each as \`BC-<n>\`, as the requirement numbers them`,
      '/codes',
    );
  }
  const twice = codes.find((code, at) => codes.indexOf(code) !== at);
  if (twice !== undefined) {
    throw refuseCriteria('CRITERIA_INPUT_INVALID', `${twice} is sent twice`, '/codes');
  }
  const { requirement: req, wordings } = await traceWordingsOf(tx, issueId);
  if (!req) {
    throw refuseCriteria(
      'CRITERIA_TRACE_UNRESOLVED',
      'this issue serves no requirement: link it to the requirement it delivers first',
      '/codes',
    );
  }
  const rows = await liveRows(tx, issueId);
  const tracedBy = new Map(
    rows.flatMap((r) => {
      const code = wordings.find((w) => w.id === r.requirementCriterionId)?.code;
      return code ? [[code, r] as const] : [];
    }),
  );
  let next = Math.max(0, ...rows.map((r) => r.n)) + 1;
  let position = rows.length;
  const written: Array<{
    n: number;
    statement: string;
    requirementCriterionId: string;
    position: number;
  }> = [];
  const refreshed = new Set<string>();
  for (const code of codes) {
    const wording = liveWordingAt(wordings, code, req.current);
    if (!wording) {
      throw refuseCriteria(
        'CRITERIA_TRACE_UNRESOLVED',
        `REQ-${req.seq} has no wording of ${code} live at revision ${req.current ?? 'none'}, its current one`,
        '/codes',
      );
    }
    const held = tracedBy.get(code);
    if (held?.requirementCriterionId === wording.id) {
      throw refuseCriteria(
        'CRITERIA_TRACE_DUPLICATE',
        `REQ-${req.seq} ${code} is already traced by criterion ${held.n} of this issue, at its current wording`,
        '/codes',
      );
    }
    const statement = `(REQ-${req.seq} ${code}) ${wording.body.trim()}`;
    if (held) refreshed.add(held.id);
    written.push(
      held
        ? { n: held.n, statement, requirementCriterionId: wording.id, position: held.position }
        : { n: next++, statement, requirementCriterionId: wording.id, position: position++ },
    );
  }
  for (const id of refreshed) {
    await tx.update(issueCriteria).set({ retiredAt: sql`now()` }).where(eq(issueCriteria.id, id));
  }
  for (const c of written) await tx.insert(issueCriteria).values({ issueId, ...c });
  const text = renderCriteriaText(
    [...rows.filter((r) => !refreshed.has(r.id)), ...written]
      .sort((a, b) => a.n - b.n)
      .map(({ n, statement }) => ({ n, statement: statement.trim() })),
  );
  await tx.update(issues).set({ acceptanceCriteria: text }).where(eq(issues.id, issueId));
  return true;
}
