// The decisions that may be a person's ruling for a production act (REQ-80 BC-11): a standing
// `decision` record naming an environment in its `production` field. Whether one opens that
// environment's protected variables to a run is the variables door's to decide
// (`project-config/variables-rules.ts:rulingRead`); this reads them, withdrawn ones left out.

import { RULING_ENVIRONMENT_FIELD, recordAction } from '@forge/contracts/record-events';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { ISSUE_TERMINAL } from '../../db/retention-shape.js';
import { issues, projects } from '../../db/schema.js';
import { activityLog } from '../../db/schema-activity.js';
import { formatIssueRef } from '../../lib/issue-ref.js';
import { readDecisionUntil } from './decision-until.js';
import { notWithdrawnSql } from './withdrawn.js';

/** One decision naming a production environment, as the variables door reads it. */
export interface DecisionNamingProductionRow {
  id: string;
  issueId: string;
  issueKey: string;
  issueStatus: string;
  environment: string;
  act: string | null;
  untilAt: Date | null;
  writer: { type: string; id: string; agency: 'human' | 'agent' };
}

const fieldOf = (fields: unknown, key: string): string | null => {
  if (!Array.isArray(fields)) return null;
  const hit = fields.find((f) => f?.key === key && typeof f.value === 'string');
  return typeof hit?.value === 'string' ? hit.value.trim() : null;
};

/**
 * The standing decisions naming a production environment on `runIssueIds`, whatever their status,
 * and on the project's other open issues, oldest first. Core's own decisions are never a person's
 * ruling and are left out.
 */
export async function decisionsNamingProduction(
  projectId: string,
  runIssueIds: readonly string[],
): Promise<DecisionNamingProductionRow[]> {
  const reach =
    runIssueIds.length > 0
      ? or(inArray(issues.id, [...runIssueIds]), sql`${issues.status} NOT IN ${ISSUE_TERMINAL}`)
      : sql`${issues.status} NOT IN ${ISSUE_TERMINAL}`;
  const rows = await db
    .select({
      id: activityLog.id,
      issueId: activityLog.issueId,
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      actorAgency: activityLog.actorAgency,
      payload: activityLog.payload,
      issSeq: issues.issSeq,
      status: issues.status,
      prefix: projects.issuePrefix,
    })
    .from(activityLog)
    .innerJoin(issues, eq(issues.id, activityLog.issueId))
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(
      and(
        eq(issues.projectId, projectId),
        reach,
        eq(activityLog.action, recordAction('decision')),
        sql`${activityLog.payload}->'fields' @> ${JSON.stringify([{ key: RULING_ENVIRONMENT_FIELD }])}::jsonb`,
        sql`coalesce(${activityLog.payload}->>'writer', '') <> 'core'`,
        notWithdrawnSql,
      ),
    )
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
  return rows.flatMap((r) => {
    const fields = (r.payload as { fields?: unknown } | null)?.fields;
    const environment = fieldOf(fields, RULING_ENVIRONMENT_FIELD);
    if (!environment) return [];
    const until = fieldOf(fields, 'until');
    const read = until ? readDecisionUntil(until) : null;
    return [
      {
        id: r.id,
        issueId: r.issueId,
        issueKey: formatIssueRef(r.prefix, r.issSeq),
        issueStatus: r.status,
        environment,
        act: fieldOf(fields, 'decision') || null,
        untilAt: read?.kind === 'date' ? read.at : null,
        writer: { type: r.actorType, id: r.actorId, agency: r.actorAgency },
      },
    ];
  });
}
