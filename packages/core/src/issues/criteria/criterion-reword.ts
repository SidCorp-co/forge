// One criterion's wording corrected in place (coordinator ruling 2026-10-26). adminhub-fe ISS-63:
// criterion 3 named `/orders/list` where the Orders list is `/orders`, and the only door was the
// whole-list PUT, which retires a reworded criterion and with it the verdicts on its old wording;
// the master could not tell that from its answer, so the wrong text stayed. A correction keeps the
// criterion's id, so its verdicts and probes stand, and the old and new text are recorded on its
// history (`issue.criterion.reworded`) with the reason. Its trace is kept: a correction that would
// trace it to another business criterion is the whole-list write's, refused here by name.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { criterionVerdicts, issueCriteria } from '../../db/schema-issue-criteria.js';
import { type Actor, recordActivityTx } from '../activity.js';
import { renderCriteriaText, strayTraceTagsOf, traceTagOf } from './criteria-text.js';
import { liveRows, lockIssue, refuseCriteria } from './store.js';

/** A criterion named by its number on the issue, or by its id. */
export type CriterionRef = { n: number } | { id: string };

export const REWORDED = 'issue.criterion.reworded';

type LiveRow = Awaited<ReturnType<typeof liveRows>>[number];

/** The live criterion `ref` names, refused by name with the ones the issue has. */
export function criterionNamed<R extends { id: string; n: number }>(
  live: readonly R[],
  ref: CriterionRef,
): R {
  const row = live.find((r) => ('n' in ref ? r.n === ref.n : r.id === ref.id));
  if (row) return row;
  const named = 'n' in ref ? `criterion ${ref.n}` : `criterion id ${ref.id}`;
  const held = live
    .map((r) => r.n)
    .sort((a, b) => a - b)
    .join(', ');
  throw refuseCriteria(
    'CRITERION_UNKNOWN',
    `this issue has no live ${named}; its live criteria are ${held || 'none'}`,
  );
}

function traceKey(statement: string): string {
  const tag = traceTagOf(statement);
  return tag.kind === 'tag' ? `(REQ-${tag.requirementSeq} ${tag.code})` : tag.kind;
}

export interface Reworded {
  criterionId: string;
  n: number;
  changed: boolean;
  before: string;
  after: string;
  /** The verdicts recorded on the criterion, every one kept: they stand on the corrected wording. */
  keptVerdicts: string[];
}

/** Correct one live criterion's wording, keeping its id and its verdicts; null where the issue is gone. */
export async function rewordCriterion(
  tx: Tx,
  args: { issueId: string; ref: CriterionRef; statement: string; reason: string; actor: Actor },
): Promise<Reworded | null> {
  const issue = await lockIssue(tx, args.issueId);
  if (!issue) return null;
  const live = await liveRows(tx, issue.id);
  const row = criterionNamed(live, args.ref);
  const after = args.statement.trim();
  const kept = await tx
    .select({ id: criterionVerdicts.id })
    .from(criterionVerdicts)
    .where(eq(criterionVerdicts.criterionId, row.id))
    .orderBy(criterionVerdicts.createdAt, criterionVerdicts.id);
  const keptVerdicts = kept.map((v) => v.id);
  const answer = { criterionId: row.id, n: row.n, before: row.statement, after, keptVerdicts };
  if (after === row.statement) return { ...answer, changed: false };
  const twin = live.find((r) => r.id !== row.id && r.statement === after);
  if (twin) {
    throw refuseCriteria(
      'CRITERIA_INPUT_INVALID',
      `criterion ${twin.n} already says this; two criteria with one wording cannot be told apart`,
      '/statement',
    );
  }
  if (traceKey(after) !== traceKey(row.statement)) {
    throw refuseCriteria(
      'CRITERION_REWORD_TRACE',
      `criterion ${row.n} opens with ${traceKey(row.statement)} and the correction opens with ${traceKey(after)}: a wording correction keeps the criterion's trace, so its verdicts still prove what they proved. To trace it to another business criterion, replace the criteria (\`PUT /api/issues/:id/criteria\`), which retires it and its verdicts`,
      '/statement',
    );
  }
  const stray = strayTraceTagsOf(after);
  if (stray.length > 0) {
    throw refuseCriteria(
      'CRITERIA_TRACE_NOT_LEADING',
      `the correction carries ${stray.join(', ')} after the start of its line, where a tag traces nothing`,
      '/statement',
    );
  }
  await tx
    .update(issueCriteria)
    .set({ statement: after })
    .where(and(eq(issueCriteria.id, row.id), eq(issueCriteria.issueId, issue.id)));
  const text = renderCriteriaText(
    live
      .map((r) => (r.id === row.id ? { ...r, statement: after } : r))
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
    action: REWORDED,
    payload: {
      criterionId: row.id,
      n: row.n,
      before: row.statement,
      after,
      reason: args.reason.trim(),
      keptVerdicts: keptVerdicts.length,
    },
  });
  return { ...answer, changed: true };
}

/** A criterion's wording history, oldest first: each correction with its old and new text and why. */
export async function rewordingsOf(
  tx: Tx,
  issueId: string,
  criterionId: string,
): Promise<Array<{ at: string; before: string; after: string; reason: string }>> {
  const rows = (await tx.execute(sql`
    SELECT created_at, payload FROM activity_log
     WHERE issue_id = ${issueId} AND action = ${REWORDED}
       AND payload ->> 'criterionId' = ${criterionId}
     ORDER BY created_at, id`)) as unknown as Array<{
    created_at: string | Date;
    payload: { before: string; after: string; reason: string };
  }>;
  return rows.map((r) => ({
    at: new Date(r.created_at).toISOString(),
    before: r.payload.before,
    after: r.payload.after,
    reason: r.payload.reason,
  }));
}

/**
 * What a whole-list write did to the verdicts already recorded: those on a criterion it kept stand,
 * and those on a criterion it retired (reworded or removed) stop counting, named one by one so the
 * answer never leaves the caller to guess.
 */
export async function verdictsAcrossPut(
  tx: Tx,
  before: readonly LiveRow[],
  after: ReadonlySet<string>,
): Promise<{
  kept: string[];
  voided: Array<{ verdictId: string; criterionId: string; n: number; statement: string }>;
  rule: string;
}> {
  const rows =
    before.length === 0
      ? []
      : await tx
          .select({ id: criterionVerdicts.id, criterionId: criterionVerdicts.criterionId })
          .from(criterionVerdicts)
          .where(
            inArray(
              criterionVerdicts.criterionId,
              before.map((r) => r.id),
            ),
          )
          .orderBy(criterionVerdicts.createdAt, criterionVerdicts.id);
  const byId = new Map(before.map((r) => [r.id, r]));
  const kept: string[] = [];
  const voided: Array<{ verdictId: string; criterionId: string; n: number; statement: string }> =
    [];
  for (const v of rows) {
    const row = byId.get(v.criterionId);
    if (!row || after.has(v.criterionId)) kept.push(v.id);
    else voided.push({ verdictId: v.id, criterionId: row.id, n: row.n, statement: row.statement });
  }
  return {
    kept,
    voided,
    rule: 'a criterion whose wording is unchanged keeps its verdicts; a reworded or removed one is retired and its verdicts stop counting. To correct one wording and keep its verdicts, PATCH /api/issues/:id/criteria/:n',
  };
}
