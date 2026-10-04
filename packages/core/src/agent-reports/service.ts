/**
 * The agent-report store, for whichever surface asks.
 *
 * `reportColumns` is the shape every read answers with — it joins the project
 * slug and the triager's name in, so a caller reading the feed never resolves either itself.
 */

import type { AgentReportView } from '@forge/contracts/agent-reports';
import { and, count, desc, eq, inArray, ne, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type AgentReportKind,
  type AgentReportSeverity,
  type AgentReportTarget,
  agentReports,
  agentSessions,
  issues,
  type OrgMemberRole,
  type ProjectMemberRole,
  projects,
  scheduleRuns,
} from '../db/schema.js';
import { activeIssuePrefix } from '../issues/index.js';
import { type PipelineCaller, resolvePipelineContext } from '../jobs/index.js';
import { maxProjectRole, orgDerivedProjectRole } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { holds } from '../permissions/index.js';
import { agentReportsPorts } from './ports.js';

const reportColumns = {
  id: agentReports.id,
  projectId: agentReports.projectId,
  projectSlug: projects.slug,
  issueId: agentReports.issueId,
  runId: agentReports.runId,
  jobId: agentReports.jobId,
  stage: agentReports.stage,
  kind: agentReports.kind,
  severity: agentReports.severity,
  target: agentReports.target,
  targetRef: agentReports.targetRef,
  summary: agentReports.summary,
  detail: agentReports.detail,
  suggestion: agentReports.suggestion,
  signalKey: agentReports.signalKey,
  sessionId: agentReports.sessionId,
  scheduleRunId: agentReports.scheduleRunId,
  triage: agentReports.triage,
  triagedById: agentReports.triagedBy,
  triagedAt: agentReports.triagedAt,
  triageReason: agentReports.triageReason,
  duplicateOf: agentReports.duplicateOf,
  linkedIssueId: agentReports.linkedIssueId,
  feedbackId: agentReports.feedbackId,
  createdAt: agentReports.createdAt,
} as const;

export async function countReportsForJob(jobId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(agentReports)
    .where(eq(agentReports.jobId, jobId))
    .limit(1);
  return Number(row?.n ?? 0);
}

export async function listReports(conditions: Array<SQL | undefined>, limit: number) {
  return db
    .select(reportColumns)
    .from(agentReports)
    .leftJoin(projects, eq(projects.id, agentReports.projectId))
    .where(and(...conditions))
    .orderBy(desc(agentReports.createdAt))
    .limit(limit);
}

export async function readReport(reportId: string) {
  const [row] = await db
    .select(reportColumns)
    .from(agentReports)
    .leftJoin(projects, eq(projects.id, agentReports.projectId))
    .where(eq(agentReports.id, reportId))
    .limit(1);
  return row ?? null;
}

// A triage across every project moves reports only where the caller holds project.write, as on the
// single-report and project doors.
export function writableProjectIds(
  rows: readonly {
    id: string;
    memberRole: ProjectMemberRole | null;
    orgRole: OrgMemberRole | null;
    grants: readonly string[] | null;
  }[],
): string[] {
  return rows
    .filter((r) =>
      holds(
        {
          projectId: r.id,
          role: maxProjectRole(r.memberRole, orgDerivedProjectRole(r.orgRole)),
          grants: r.grants ?? [],
        },
        'project.write',
      ),
    )
    .map((r) => r.id);
}

/** The issue a file act links, when it sits in one of `projectIds`; null is the caller's 404. */
export async function visibleIssue(
  issueId: string,
  projectIds: string[],
): Promise<{ id: string; key: string } | null> {
  if (projectIds.length === 0) return null;
  const [row] = await db
    .select({ id: issues.id, projectId: issues.projectId, seq: issues.issSeq })
    .from(issues)
    .where(and(eq(issues.id, issueId), inArray(issues.projectId, projectIds)))
    .limit(1);
  if (!row) return null;
  return { id: row.id, key: formatIssueRef(await activeIssuePrefix(row.projectId), row.seq) };
}

// cm:why design automation rev 1 (step report; REQ-16 BC-2): the fire a session runs for is named
// on its metadata (`scheduleRunId`, ISS-112); a report takes the fire only when that row exists, so a
// session whose fire went with its schedule files an unlinked report rather than a dangling id
export async function fireOfSession(sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  const [row] = await db
    .select({ id: scheduleRuns.id })
    .from(agentSessions)
    .innerJoin(
      scheduleRuns,
      sql`${scheduleRuns.id}::text = ${agentSessions.metadata} ->> 'scheduleRunId'`,
    )
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return row?.id ?? null;
}

// cm:why design automation rev 1 (step settle; REQ-16 BC-2, ISS-114): an issue a scheduled session
// files names that session's fire, resolved as a report's is: the box credential's one live session
// on its project, then the fire on that session's metadata; a person's own credential names none
export async function fireOfCaller(caller: PipelineCaller): Promise<string | null> {
  const resolved = await resolvePipelineContext(caller);
  return resolved.ok ? fireOfSession(resolved.context.agentSessionId) : null;
}

type NewAgentReport = typeof agentReports.$inferInsert;

export async function insertReport(values: NewAgentReport): Promise<string | null> {
  const [row] = await db.insert(agentReports).values(values).returning({
    id: agentReports.id,
  });
  return row?.id ?? null;
}

type ReportRow = Awaited<ReturnType<typeof listReports>>[number];

export async function reportViews(rows: readonly ReportRow[]): Promise<AgentReportView[]> {
  const byProject = new Map<string, string[]>();
  for (const r of rows) {
    if (r.feedbackId)
      byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r.feedbackId]);
  }
  const links = new Map(
    (
      await Promise.all(
        [...byProject].map(([projectId, ids]) => agentReportsPorts().reportLinksOf(projectId, ids)),
      )
    ).flatMap((m) => [...m]),
  );
  const people = await peopleOf(rows.map((r) => r.triagedById));
  return rows.map(({ feedbackId, triagedById, ...r }) => ({
    ...r,
    triagedBy: triagedById
      ? { id: triagedById, name: people.get(triagedById)?.name ?? null }
      : null,
    triagedAt: r.triagedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    feedback: feedbackId ? (links.get(feedbackId) ?? null) : null,
  }));
}

export type { AgentReportKind, AgentReportSeverity, AgentReportTarget };

/** Every report at triage new, then the newest `triaged` triaged ones, of a project or of one schedule's fires. */
export async function reportViewsIn(scope: {
  projectId: string;
  scheduleId?: string;
  triaged: number;
}) {
  const inProject = eq(agentReports.projectId, scope.projectId);
  const fromSchedule = scope.scheduleId
    ? inArray(
        agentReports.scheduleRunId,
        db
          .select({ id: scheduleRuns.id })
          .from(scheduleRuns)
          .where(eq(scheduleRuns.scheduleId, scope.scheduleId)),
      )
    : inProject;
  const base = () =>
    db
      .select(reportColumns)
      .from(agentReports)
      .leftJoin(projects, eq(projects.id, agentReports.projectId));
  const [fresh, triaged] = await Promise.all([
    base().where(and(fromSchedule, eq(agentReports.triage, 'new'))),
    base()
      .where(and(fromSchedule, ne(agentReports.triage, 'new')))
      .orderBy(desc(agentReports.createdAt), desc(agentReports.id))
      .limit(scope.triaged),
  ]);
  return reportViews([...fresh, ...triaged]);
}

/** One report of a project, as a list of at most one. */
export async function reportViewById(projectId: string, reportId: string) {
  const rows = await db
    .select(reportColumns)
    .from(agentReports)
    .leftJoin(projects, eq(projects.id, agentReports.projectId))
    .where(and(eq(agentReports.projectId, projectId), eq(agentReports.id, reportId)))
    .limit(1);
  return reportViews(rows);
}
