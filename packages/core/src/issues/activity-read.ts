import { issueUpdatedAsChanges } from '@forge/contracts/field-changes';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, desc, eq, like, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityLog, issues } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { issueArchiveSide } from './archive.js';

const ACTIVITY_ROW_COLUMNS = {
  id: activityLog.id,
  issueId: activityLog.issueId,
  action: activityLog.action,
  actorType: activityLog.actorType,
  actorAgency: activityLog.actorAgency,
  actorId: activityLog.actorId,
  payload: activityLog.payload,
  createdAt: activityLog.createdAt,
} as const;

export type ActivityRow = {
  id: string;
  issueId: string;
  action: string;
  actorType: string;
  actorAgency: ActorAgency;
  actorId: string;
  payload: unknown;
  createdAt: Date;
};

/**
 * ISS-124 amnesty (`.forge/conformance.json` $amnesties, `activity-snapshot-read`): an
 * `issue.updated` row the boot backfill has not converted yet reads as the changes it made. A row
 * that is not the snapshot shape is returned as stored, named in the log, never dropped.
 */
function readable(rows: ActivityRow[]): ActivityRow[] {
  return rows.map((row) => {
    if (row.action !== 'issue.updated') return row;
    try {
      return { ...row, payload: issueUpdatedAsChanges(row.payload) };
    } catch (err) {
      logger.warn(
        { err, activityId: row.id, issueId: row.issueId },
        'activity: a snapshot row cannot be read as changes',
      );
      return row;
    }
  });
}

/** An issue's activity, newest first, older than `before` when given. */
export async function listIssueActivity(
  issueId: string,
  limit: number,
  before: Date | undefined,
): Promise<ActivityRow[]> {
  const conditions = [eq(activityLog.issueId, issueId)];
  if (before) conditions.push(lt(activityLog.createdAt, before));
  const rows = await db
    .select({ ...ACTIVITY_ROW_COLUMNS })
    .from(activityLog)
    .where(and(...conditions))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);
  return readable(rows as ActivityRow[]);
}

/** A project's activity over its live issues, newest first, optionally of one action family. */
export async function listProjectActivity(
  projectId: string,
  limit: number,
  before: Date | undefined,
  type: string | undefined,
): Promise<ActivityRow[]> {
  const conditions = [eq(issues.projectId, projectId), ...issueArchiveSide(false)];
  if (before) conditions.push(lt(activityLog.createdAt, before));
  if (type) conditions.push(like(activityLog.action, `${type}.%`));
  const rows = await db
    .select({ ...ACTIVITY_ROW_COLUMNS })
    .from(activityLog)
    .innerJoin(issues, eq(issues.id, activityLog.issueId))
    .where(and(...conditions))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);
  return readable(rows as ActivityRow[]);
}
