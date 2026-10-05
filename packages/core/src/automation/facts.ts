// The rows the automation read model derives from (ISS-114): schedules, their fires and what
// each fire produced counted by join (reports and issues by schedule_run_id, notifications by the
// fire id, proposals through the fire's session), and agent reports with the fire that filed them

import {
  AGENT_REPORT_TRIAGES,
  type AgentReportTriage,
  type AgentReportView,
} from '@forge/contracts/agent-reports';
import type { AutomationPerson, FireProducedItems } from '@forge/contracts/automation-standing';
import { and, asc, count, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentReports,
  agentSessions,
  issues,
  notifications,
  pipelineRuns,
  scheduleRuns,
  schedules,
} from '../db/schema.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import type { FireFacts, ReportFacts, ScheduleFacts, StewardAction } from './standing.js';

export async function scheduleFacts(
  projectId: string,
  scheduleId?: string,
): Promise<ScheduleFacts[]> {
  const where = [eq(schedules.projectId, projectId)];
  if (scheduleId) where.push(eq(schedules.id, scheduleId));
  const rows = await db
    .select({
      id: schedules.id,
      projectId: schedules.projectId,
      name: schedules.name,
      kind: schedules.kind,
      cron: schedules.cron,
      enabled: schedules.enabled,
      targetProjectSlug: schedules.targetProjectSlug,
      nextRunAt: schedules.nextRunAt,
      createdAt: schedules.createdAt,
      ownerId: schedules.ownerId,
    })
    .from(schedules)
    .where(and(...where))
    .orderBy(asc(schedules.createdAt), asc(schedules.id));
  const owners = await ownersOf(rows.map((r) => r.ownerId));
  return rows.map(({ ownerId, ...s }) => ({
    ...s,
    owner: ownerId ? (owners.get(ownerId) ?? null) : null,
  }));
}

/** Each owner by id with the name a person reads; an id whose account is gone reads as no owner. */
async function ownersOf(ids: readonly (string | null)[]): Promise<Map<string, AutomationPerson>> {
  const people = await peopleOf(ids);
  return new Map([...people].map(([id, p]) => [id, { id, name: p.name }]));
}

const lastFireColumns = {
  id: scheduleRuns.id,
  scheduleId: scheduleRuns.scheduleId,
  status: scheduleRuns.status,
  trigger: scheduleRuns.trigger,
  startedAt: scheduleRuns.startedAt,
  finishedAt: scheduleRuns.finishedAt,
  reason: scheduleRuns.reason,
  refusal: scheduleRuns.refusal,
  sessionId: scheduleRuns.sessionId,
};

const fireColumns = {
  ...lastFireColumns,
  scheduleName: schedules.name,
  error: scheduleRuns.error,
  disposition: scheduleRuns.disposition,
  pipelineRunId: scheduleRuns.pipelineRunId,
  output: scheduleRuns.output,
  reports: sql<number>`(SELECT count(*)::int FROM agent_reports ar WHERE ar.schedule_run_id = ${scheduleRuns.id} AND ar.project_id = ${scheduleRuns.projectId})`,
  newReports: sql<number>`(SELECT count(*)::int FROM agent_reports ar WHERE ar.schedule_run_id = ${scheduleRuns.id} AND ar.project_id = ${scheduleRuns.projectId} AND ar.triage = 'new')`,
  issues: sql<number>`(SELECT count(*)::int FROM issues i WHERE i.schedule_run_id = ${scheduleRuns.id} AND i.project_id = ${scheduleRuns.projectId})`,
  notifications: sql<number>`(SELECT count(*)::int FROM notifications n WHERE n.schedule_run_id = ${scheduleRuns.id})`,
};

export type FireRow = FireFacts & { output: string | null };

interface FireScope {
  projectId: string;
  scheduleId?: string;
  fireId?: string;
  limit: number;
}

export async function fireFacts(scope: FireScope): Promise<{ fires: FireRow[]; total: number }> {
  const where: SQL[] = [eq(scheduleRuns.projectId, scope.projectId)];
  if (scope.scheduleId) where.push(eq(scheduleRuns.scheduleId, scope.scheduleId));
  if (scope.fireId) where.push(eq(scheduleRuns.id, scope.fireId));
  const [rows, [tally]] = await Promise.all([
    db
      .select(fireColumns)
      .from(scheduleRuns)
      .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
      .where(and(...where))
      .orderBy(desc(scheduleRuns.createdAt), desc(scheduleRuns.id))
      .limit(scope.limit),
    db
      .select({ n: count() })
      .from(scheduleRuns)
      .where(and(...where)),
  ]);
  return {
    fires: rows.map(({ scheduleId, ...f }) => ({
      ...f,
      scheduleId,
      reports: Number(f.reports),
      newReports: Number(f.newReports),
      issues: Number(f.issues),
      notifications: Number(f.notifications),
    })),
    total: Number(tally?.n ?? 0),
  };
}

function stewardActionsOf(report: unknown): StewardAction[] | null {
  const actions = (report as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) return null;
  return actions.flatMap((a) => {
    const x = a as Record<string, unknown> | null;
    return x && typeof x.skill === 'string' && typeof x.kind === 'string'
      ? [{ skill: x.skill, kind: x.kind, summary: typeof x.summary === 'string' ? x.summary : '' }]
      : [];
  });
}

/** The steward run report of each fire's session, read through the session the fire ran. */
export async function stewardActions(
  sessionIds: readonly string[],
): Promise<Map<string, StewardAction[] | null>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: agentSessions.id,
      report: sql<unknown>`${agentSessions.metadata} -> 'stewardReport'`,
    })
    .from(agentSessions)
    .where(inArray(agentSessions.id, [...sessionIds]));
  return new Map(rows.map((r) => [r.id, stewardActionsOf(r.report)]));
}

export async function reportCounts(projectId: string): Promise<Record<AgentReportTriage, number>> {
  const rows = await db
    .select({ triage: agentReports.triage, n: count() })
    .from(agentReports)
    .where(eq(agentReports.projectId, projectId))
    .groupBy(agentReports.triage);
  const out = Object.fromEntries(AGENT_REPORT_TRIAGES.map((t) => [t, 0])) as Record<
    AgentReportTriage,
    number
  >;
  for (const r of rows) out[r.triage] = Number(r.n);
  return out;
}

async function issueKeys(
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, { id: string; key: string; title: string; status: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      seq: issues.issSeq,
      title: issues.title,
      status: issues.status,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, [...ids])));
  const prefixes = new Map<string, string | null>();
  for (const projectId of new Set(rows.map((r) => r.projectId))) {
    prefixes.set(projectId, await activeIssuePrefix(projectId));
  }
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        key: formatIssueRef(prefixes.get(r.projectId) ?? null, r.seq),
        title: r.title,
        status: r.status,
      },
    ]),
  );
}

/**
 * Each report with the fire that filed it, that fire's schedule owner, and the issue it went to,
 * read inside the one project the caller is reading.
 */
export async function reportFacts(
  projectId: string,
  views: readonly AgentReportView[],
): Promise<ReportFacts[]> {
  const fireIds = [...new Set(views.flatMap((v) => (v.scheduleRunId ? [v.scheduleRunId] : [])))];
  const fires =
    fireIds.length === 0
      ? []
      : await db
          .select({
            id: scheduleRuns.id,
            scheduleId: schedules.id,
            scheduleName: schedules.name,
            ownerId: schedules.ownerId,
          })
          .from(scheduleRuns)
          .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
          .where(inArray(scheduleRuns.id, fireIds));
  const owners = await ownersOf(fires.map((f) => f.ownerId));
  const fireById = new Map(
    fires.map((f) => [
      f.id,
      {
        id: f.id,
        scheduleId: f.scheduleId,
        scheduleName: f.scheduleName,
        owner: f.ownerId ? (owners.get(f.ownerId) ?? null) : null,
      },
    ]),
  );
  const filed = await issueKeys(
    projectId,
    views.flatMap((v) => (v.triage === 'filed' && v.linkedIssueId ? [v.linkedIssueId] : [])),
  );
  return views.map((view) => ({
    view,
    fire: view.scheduleRunId ? (fireById.get(view.scheduleRunId) ?? null) : null,
    issue: view.linkedIssueId ? (filed.get(view.linkedIssueId) ?? null) : null,
  }));
}

/** What one fire produced inside the project read, item by item, each joined to the fire as its count is. */
export async function producedItems(
  projectId: string,
  fire: FireRow,
  proposals: FireProducedItems['proposals'],
): Promise<FireProducedItems> {
  const [reports, issueRows, notes, run] = await Promise.all([
    db
      .select({
        id: agentReports.id,
        summary: agentReports.summary,
        kind: agentReports.kind,
        severity: agentReports.severity,
        triage: agentReports.triage,
      })
      .from(agentReports)
      .where(and(eq(agentReports.scheduleRunId, fire.id), eq(agentReports.projectId, projectId)))
      .orderBy(asc(agentReports.createdAt)),
    db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.scheduleRunId, fire.id), eq(issues.projectId, projectId)))
      .orderBy(asc(issues.createdAt)),
    db
      .select({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.scheduleRunId, fire.id))
      .orderBy(asc(notifications.createdAt)),
    fire.sessionId === null && fire.pipelineRunId !== null
      ? db
          .select({ id: pipelineRuns.id, kind: pipelineRuns.kind, status: pipelineRuns.status })
          .from(pipelineRuns)
          .where(eq(pipelineRuns.id, fire.pipelineRunId))
      : Promise.resolve([]),
  ]);
  const keys = await issueKeys(
    projectId,
    issueRows.map((i) => i.id),
  );
  return {
    reports,
    proposals,
    issues: issueRows.flatMap((i) => {
      const k = keys.get(i.id);
      return k ? [k] : [];
    }),
    runs: run,
    notifications: notes.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
  };
}
