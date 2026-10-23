// The reasoned decisions written on issues (ISS-607): a `decision` record carrying a `why`, the
// shape a master or a person writes to say why an item waits. A decision core writes for a route or a
// suggestion carries no `why`, so it is never read as somebody's answer here.

import { recordAction } from '@forge/contracts/record-events';
import { and, desc, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { activityLog } from '../../db/schema-activity.js';
import { readDecisionUntil } from './decision-until.js';

export interface ReasonedDecision {
  issueId: string;
  at: Date;
  actorType: string;
  actorId: string;
  decision: string | null;
  why: string;
  /**
   * The `until` field where it names a date (an ISO 8601 date, or a date-time with its zone): the
   * decision stops holding once it has passed. Null for no `until` or a condition, which holds.
   */
  until: Date | null;
}

interface Field {
  key?: unknown;
  value?: unknown;
}

const fieldOf = (fields: unknown, key: string): string | null => {
  if (!Array.isArray(fields)) return null;
  const hit = (fields as Field[]).find((f) => f?.key === key && typeof f.value === 'string');
  const value = typeof hit?.value === 'string' ? hit.value.trim() : '';
  return value.length > 0 ? value : null;
};

/** The date an `until` names, or null for none or a condition, which no clock ends (`decision-until.ts`). */
const dateOf = (text: string | null): Date | null => {
  if (!text) return null;
  const until = readDecisionUntil(text);
  return until.kind === 'date' ? until.at : null;
};

/**
 * Every reasoned decision on these issues, newest first, but those whose writer is one of
 * `exceptUserIds` (the steward's own account): the steward never reads its own record as an answer.
 */
export async function reasonedDecisionsOn(
  issueIds: readonly string[],
  exceptUserIds: readonly string[] = [],
): Promise<ReasonedDecision[]> {
  if (issueIds.length === 0) return [];
  const rows = await db
    .select({
      issueId: activityLog.issueId,
      at: activityLog.createdAt,
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      payload: activityLog.payload,
    })
    .from(activityLog)
    .where(
      and(
        inArray(activityLog.issueId, [...issueIds]),
        sql`${activityLog.action} = ${recordAction('decision')}`,
      ),
    )
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id));
  const except = new Set(exceptUserIds);
  return rows.flatMap((row) => {
    if (row.actorType === 'user' && except.has(row.actorId)) return [];
    const fields = (row.payload as { fields?: unknown } | null)?.fields;
    const why = fieldOf(fields, 'why');
    if (!why) return [];
    return [
      {
        issueId: row.issueId,
        at: row.at,
        actorType: row.actorType,
        actorId: row.actorId,
        decision: fieldOf(fields, 'decision'),
        why,
        until: dateOf(fieldOf(fields, 'until')),
      },
    ];
  });
}
