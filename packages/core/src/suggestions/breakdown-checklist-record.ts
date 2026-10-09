/**
 * What a suggestion's own record answers to the breakdown checklist
 * (`@forge/contracts/checklist-registry:BREAKDOWN_CHECKLIST`, Requirement lifecycle r15
 * breakdown_check), which the kernel judges on every accept: a suggestion of another kind answers
 * only that it is not a breakdown, and its other questions are not asked. A breakdown answers whether
 * each issue's criteria trace a current business criterion, whether every current one is traced or
 * listed uncovered with a reason, and whether each issue states its complexity. Read under the
 * accept's lock, through its transaction.
 *
 * Every sentence here is read by a person: the kernel refuses to judge with one that shows a record
 * field's key (`@forge/contracts/checklists:fieldKeyShownIn`).
 */

import type { RecordAnswer, RecordAnswers } from '@forge/contracts/checklists';
import { requirementKey } from '@forge/contracts/requirements';
import { SUGGESTION_PAYLOADS } from '@forge/contracts/suggestions';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';

type Breakdown = ReturnType<(typeof SUGGESTION_PAYLOADS)['breakdown']['schema']['parse']>;

export interface BreakdownFacts {
  key: string;
  revision: number;
  /** The business criteria live at the revision the breakdown is accepted against. */
  live: string[];
  payload: Breakdown;
}

const listed = (codes: readonly string[]) => codes.join(', ');

/** The record answers of the breakdown checklist for a breakdown, from what it proposes. */
export function breakdownAnswersOf(f: BreakdownFacts): RecordAnswers {
  const live = new Set(f.live);
  const traced = new Set<string>();
  const untraced: string[] = [];
  for (const [i, issue] of f.payload.issues.entries()) {
    const off = issue.criteria.filter((c) => !live.has(c.tracesTo)).map((c) => c.tracesTo);
    if (off.length > 0) untraced.push(`issue ${i + 1} traces ${listed([...new Set(off)])}`);
    for (const c of issue.criteria) if (live.has(c.tracesTo)) traced.add(c.tracesTo);
  }
  const uncovered = f.payload.uncovered ?? [];
  const reasoned = new Set(uncovered.filter((u) => u.reason.trim() !== '').map((u) => u.code));
  const unreasoned = uncovered.filter((u) => u.reason.trim() === '').map((u) => u.code);
  const stale = uncovered.filter((u) => !live.has(u.code)).map((u) => u.code);
  const missing = f.live.filter((code) => !traced.has(code) && !reasoned.has(code));
  const criteria: RecordAnswer =
    untraced.length > 0
      ? {
          gap: `Some criteria trace no current business criterion of ${f.key} revision ${f.revision}: ${untraced.join('; ')}.`,
          fix: `Trace each one to a business criterion that stands at revision ${f.revision}.`,
        }
      : {
          value: `${f.payload.issues.length} ${f.payload.issues.length === 1 ? 'issue' : 'issues'}, each criterion tracing a current business criterion.`,
        };
  const coverage: RecordAnswer =
    missing.length > 0 || unreasoned.length > 0 || stale.length > 0
      ? {
          gap: [
            missing.length > 0 ? `Neither traced nor listed uncovered: ${listed(missing)}.` : null,
            unreasoned.length > 0
              ? `Listed uncovered with no reason: ${listed(unreasoned)}.`
              : null,
            stale.length > 0
              ? `Listed uncovered, and not a current business criterion of ${f.key} revision ${f.revision}: ${listed(stale)}.`
              : null,
          ]
            .filter(Boolean)
            .join(' '),
          fix: 'Trace each current business criterion from an issue, or list it uncovered with a reason.',
        }
      : {
          value:
            reasoned.size > 0
              ? `${listed([...traced].sort(byCode))} traced; ${listed([...reasoned].sort(byCode))} listed uncovered with a reason.`
              : `Every current business criterion is traced: ${listed([...traced].sort(byCode))}.`,
        };
  return {
    kind: { value: 'breakdown' },
    criteria,
    coverage,
    complexity: {
      value: f.payload.issues.map((issue, i) => `issue ${i + 1}: ${issue.complexity}`).join(', '),
    },
  };
}

const byCode = (a: string, b: string) => Number(a.slice(3)) - Number(b.slice(3));

/** The record answers of `suggestionId` for the breakdown checklist, read through `tx`. */
export async function breakdownChecklistRecord(
  tx: Tx,
  suggestionId: string,
): Promise<RecordAnswers> {
  const rows = (await tx.execute(sql`
    SELECT s.kind, s.payload, r.req_seq, r.current_revision, r.id AS requirement_id
      FROM suggestions s LEFT JOIN requirements r ON r.id = s.requirement_id
     WHERE s.id = ${suggestionId}
  `)) as unknown as Array<{
    kind: string;
    payload: unknown;
    req_seq: number | null;
    current_revision: number | null;
    requirement_id: string | null;
  }>;
  const row = rows[0];
  if (!row) throw new Error(`breakdown checklist: suggestion ${suggestionId} has no row to read`);
  if (row.kind !== 'breakdown') return { kind: { value: 'other' } };
  const parsed = SUGGESTION_PAYLOADS.breakdown.schema.safeParse(row.payload);
  if (
    !parsed.success ||
    row.requirement_id === null ||
    row.current_revision === null ||
    row.req_seq === null
  ) {
    // the accept's own guard refuses an unreadable breakdown first (`breakdown.ts:storedBreakdownRefusal`)
    throw new Error(
      `breakdown checklist: suggestion ${suggestionId} holds no breakdown of a requirement with a head`,
    );
  }
  const revision = Number(row.current_revision);
  const live = (await tx.execute(sql`
    SELECT code FROM requirement_criteria
     WHERE requirement_id = ${row.requirement_id}
       AND since_revision <= ${revision}
       AND (retired_revision IS NULL OR retired_revision > ${revision})
  `)) as unknown as Array<{ code: string }>;
  return breakdownAnswersOf({
    key: requirementKey(Number(row.req_seq)),
    revision,
    live: live.map((l) => l.code).sort(byCode),
    payload: parsed.data,
  });
}
