import { and, asc, desc, eq, gte, like, lt, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityLog, issues } from '../db/schema.js';
import type { ActorAgency } from './actor-agency.js';
import { issueArchiveSide } from './archive.js';

export const ACTIVITY_ROW_COLUMNS = {
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
  return rows as ActivityRow[];
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
  return rows as ActivityRow[];
}

/** One activity row with the project of its issue, or null. */
export async function loadActivity(activityId: string) {
  const [row] = await db
    .select({
      id: activityLog.id,
      issueId: activityLog.issueId,
      action: activityLog.action,
      payload: activityLog.payload,
      projectId: issues.projectId,
    })
    .from(activityLog)
    .innerJoin(issues, eq(issues.id, activityLog.issueId))
    .where(eq(activityLog.id, activityId))
    .limit(1);
  return row ?? null;
}

/** A project's status-change activity in a window, grouped by issue and in time order. */
export async function statusChangeRows(
  projectId: string,
  from: Date | undefined,
  to: Date | undefined,
  limit: number,
) {
  const conditions = [
    eq(issues.projectId, projectId),
    eq(activityLog.action, 'issue.statusChanged'),
  ];
  if (from) conditions.push(gte(activityLog.createdAt, from));
  if (to) conditions.push(lte(activityLog.createdAt, to));
  return db
    .select({
      issueId: activityLog.issueId,
      payload: activityLog.payload,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .innerJoin(issues, eq(issues.id, activityLog.issueId))
    .where(and(...conditions))
    .orderBy(asc(activityLog.issueId), asc(activityLog.createdAt))
    .limit(limit);
}
