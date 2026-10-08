// The one writer of `status_reports`: a report is the project status read (`project-status/read.ts`)
// stored as it answered, never computed a second way and never changed after. What changed since the
// previous report is read from the two stored rows (`@forge/contracts/status-reports:statusReportDiff`).

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ProjectStatus } from '@forge/contracts/project-status';
import {
  STATUS_REPORT_HISTORY_ROWS,
  type StatusReportDetail,
  type StatusReportMeta,
  statusReportDiff,
} from '@forge/contracts/status-reports';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { schedules, statusReports } from '../db/schema.js';
import type { ProjectAccess } from '../lib/authz.js';
import { peopleOf } from '../lib/people.js';
import { statusReportsPorts } from './ports.js';

type Row = typeof statusReports.$inferSelect;

type Producer =
  | { kind: 'person'; userId: string }
  | { kind: 'schedule'; userId: string; scheduleId: string; period: Date };

/** Read the project status as the producer reads it and keep it: the stored row, immutable from here. */
export async function storeStatusReport(args: {
  projectId: string;
  access: ProjectAccess;
  agency: ActorAgency;
  days: number;
  producer: Producer;
  now?: Date;
}): Promise<Row> {
  const status = await statusReportsPorts().readProjectStatus({
    projectId: args.projectId,
    access: args.access,
    userId: args.producer.userId,
    agency: args.agency,
    days: args.days,
    ...(args.now ? { now: args.now } : {}),
  });
  const [row] = await db
    .insert(statusReports)
    .values({
      projectId: args.projectId,
      producerKind: args.producer.kind,
      producedBy: args.producer.userId,
      scheduleId: args.producer.kind === 'schedule' ? args.producer.scheduleId : null,
      period: args.producer.kind === 'schedule' ? args.producer.period : null,
      asOf: new Date(status.asOf),
      days: status.days,
      report: status,
    })
    .returning();
  if (!row) throw new Error('status_reports: insert returned no row');
  return row;
}

/** The report a schedule already stored for `period`, if any. */
export async function reportOfPeriod(scheduleId: string, period: Date): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(statusReports)
    .where(and(eq(statusReports.scheduleId, scheduleId), eq(statusReports.period, period)))
    .limit(1);
  return row ?? null;
}

async function metaOf(rows: readonly Row[]): Promise<StatusReportMeta[]> {
  const scheduleIds = [...new Set(rows.flatMap((r) => (r.scheduleId ? [r.scheduleId] : [])))];
  const [people, named] = await Promise.all([
    peopleOf(rows.map((r) => r.producedBy)),
    scheduleIds.length
      ? db
          .select({ id: schedules.id, name: schedules.name })
          .from(schedules)
          .where(inArray(schedules.id, scheduleIds))
      : Promise.resolve([]),
  ]);
  const scheduleName = new Map(named.map((s) => [s.id, s.name]));
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    asOf: r.asOf.toISOString(),
    days: r.days,
    period: r.period?.toISOString() ?? null,
    producer: {
      kind: r.producerKind,
      user: r.producedBy
        ? { id: r.producedBy, name: people.get(r.producedBy)?.name ?? null }
        : null,
      schedule:
        r.scheduleId && scheduleName.has(r.scheduleId)
          ? { id: r.scheduleId, name: scheduleName.get(r.scheduleId) as string }
          : null,
    },
  }));
}

export async function reportMeta(row: Row): Promise<StatusReportMeta> {
  const [meta] = await metaOf([row]);
  if (!meta) throw new Error(`status report ${row.id}: no meta`);
  return meta;
}

/** A project's reports, newest first. */
export async function listStatusReports(projectId: string): Promise<StatusReportMeta[]> {
  const rows = await db
    .select()
    .from(statusReports)
    .where(eq(statusReports.projectId, projectId))
    .orderBy(desc(statusReports.asOf), desc(statusReports.createdAt))
    .limit(STATUS_REPORT_HISTORY_ROWS);
  return metaOf(rows);
}

/** The report kept just before `row` in its project, if any. */
export async function previousReport(row: Row): Promise<Row | null> {
  const [prev] = await db
    .select()
    .from(statusReports)
    .where(and(eq(statusReports.projectId, row.projectId), lt(statusReports.asOf, row.asOf)))
    .orderBy(desc(statusReports.asOf), desc(statusReports.createdAt))
    .limit(1);
  return prev ?? null;
}

export async function reportRow(projectId: string, reportId: string): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(statusReports)
    .where(and(eq(statusReports.id, reportId), eq(statusReports.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

/** One stored report with the one before it and what changed between the two. */
export async function readStatusReport(row: Row): Promise<StatusReportDetail> {
  const prev = await previousReport(row);
  const [report, previous] = await metaOf(prev ? [row, prev] : [row]);
  if (!report) throw new Error(`status report ${row.id}: no meta`);
  const status = row.report as ProjectStatus;
  return {
    report,
    status,
    previous: previous ?? null,
    diff: prev ? statusReportDiff(prev.report as ProjectStatus, status) : null,
  };
}
