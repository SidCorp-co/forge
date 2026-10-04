/**
 * The agent-report store, for whichever surface asks.
 *
 * `reportColumns` is the shape every read answers with — it joins the project
 * slug and the triager's name in, so a caller reading the feed never resolves either itself.
 */

import type {
  AgentReportTriage,
  AgentReportTriageEffect,
  AgentReportView,
  TriageAgentReportRequest,
} from '@forge/contracts/agent-reports';
import { and, asc, count, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
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
import { feedback } from '../db/schema-feedback.js';
import { reportLinksOf } from '../feedback/about.js';
import { feedbackKey } from '../feedback/read.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { writeRecordEvent } from '../issues/record-events/store.js';
import { type PipelineCaller, resolvePipelineContext } from '../jobs/active-job-context.js';
import { maxProjectRole, orgDerivedProjectRole } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import type { Refusal } from '../lib/refusal.js';
import { holds } from '../permissions/index.js';
import { fileIssueIn, type IssueChannel } from './file.js';
import { bulkMoves, filedIntoIssueRefusal, type TriageFacts, triageRefusals } from './rules.js';

export const reportColumns = {
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

export type NewAgentReport = typeof agentReports.$inferInsert;

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
      await Promise.all([...byProject].map(([projectId, ids]) => reportLinksOf(projectId, ids)))
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

export interface ReportActor {
  userId: string;
  agency: ActorAgency;
}

async function lockedFacts(tx: Tx, scope: SQL[]) {
  const rows = await tx
    .select({
      id: agentReports.id,
      projectId: agentReports.projectId,
      triage: agentReports.triage,
      triagedAt: agentReports.triagedAt,
      triageReason: agentReports.triageReason,
      duplicateOf: agentReports.duplicateOf,
      triagedBy: agentReports.triagedBy,
      issueSeq: issues.issSeq,
      issueProjectId: issues.projectId,
      feedbackSeq: feedback.fbSeq,
      summary: agentReports.summary,
      detail: agentReports.detail,
      suggestion: agentReports.suggestion,
      kind: agentReports.kind,
      severity: agentReports.severity,
      target: agentReports.target,
      targetRef: agentReports.targetRef,
    })
    .from(agentReports)
    .leftJoin(issues, eq(issues.id, agentReports.linkedIssueId))
    .leftJoin(feedback, eq(feedback.id, agentReports.feedbackId))
    .where(and(...scope))
    .orderBy(asc(agentReports.createdAt), asc(agentReports.id))
    .for('update', { of: agentReports });
  const people = await peopleOf(rows.map((r) => r.triagedBy));
  const prefixes = new Map<string, string | null>();
  for (const r of rows) {
    if (r.issueProjectId && !prefixes.has(r.issueProjectId))
      prefixes.set(r.issueProjectId, await activeIssuePrefix(r.issueProjectId));
  }
  return rows.map((r) => ({
    ...r,
    facts: {
      id: r.id,
      projectId: r.projectId,
      triage: r.triage,
      triagedByName: r.triagedBy ? (people.get(r.triagedBy)?.name ?? null) : null,
      triagedAt: r.triagedAt,
      triageReason: r.triageReason,
      duplicateOf: r.duplicateOf,
      linkedIssueKey:
        r.issueSeq === null || !r.issueProjectId
          ? null
          : formatIssueRef(prefixes.get(r.issueProjectId) ?? null, r.issueSeq),
      feedbackKey: r.feedbackSeq === null ? null : feedbackKey(r.feedbackSeq),
    } satisfies TriageFacts,
  }));
}

export type LockedReport = Awaited<ReturnType<typeof lockedFacts>>[number];

const TO: Record<TriageAgentReportRequest['act'], AgentReportTriage> = {
  file: 'filed',
  dismiss: 'dismissed',
  duplicate: 'duplicate',
  reopen: 'new',
};

export type TriageOutcome =
  | { ok: true; effect: AgentReportTriageEffect }
  | { ok: false; refusals: Refusal[] };

// cm:why design automation rev 1 (steps triage, file, dismiss; REQ-16 BC-3): every triage act, from
// either door, single or by signal, is this one write: the reports are locked, every rule is read
// before anything is written, a file creates its draft issue in the same transaction, and each row
// carries its own triagedBy. A bulk act moves the reports its act applies to and names the rest
export async function triageReports(input: {
  scope: SQL[];
  bulk: boolean;
  act: TriageAgentReportRequest;
  actor: ReportActor;
  channel: IssueChannel;
  linkIssue: { id: string; key: string } | null;
}): Promise<TriageOutcome> {
  const { act, actor } = input;
  return db.transaction(async (tx) => {
    const locked = await lockedFacts(tx, input.scope);
    let original: { id: string; projectId: string } | null = null;
    if (act.act === 'duplicate') {
      const [o] = await tx
        .select({ id: agentReports.id, projectId: agentReports.projectId })
        .from(agentReports)
        .where(eq(agentReports.id, act.duplicateOf));
      original = o ?? null;
    }
    const moving = input.bulk ? locked.filter((r) => bulkMoves(r.facts, act)) : locked;
    const untouched = locked
      .filter((r) => !moving.includes(r))
      .map((r) => ({ id: r.id, triage: r.triage }));
    const refusals = moving.flatMap((r) => triageRefusals(r.facts, act, original));
    if (refusals.length > 0) return { ok: false, refusals };
    const to = TO[act.act];
    if (moving.length === 0) {
      return {
        ok: true,
        effect: { act: act.act, triage: to, reports: [], issue: null, untouched },
      };
    }
    let issue: AgentReportTriageEffect['issue'] = null;
    if (act.act === 'file') {
      issue = input.linkIssue
        ? { ...input.linkIssue, created: false }
        : await fileIssueIn(tx, moving, act.createIssue ?? {}, actor, input.channel);
    }
    const now = new Date();
    const triaged = act.act !== 'reopen';
    const ids = moving.map((r) => r.id);
    await tx
      .update(agentReports)
      .set({
        triage: to,
        triagedBy: triaged ? actor.userId : null,
        triagedAgency: triaged ? actor.agency : null,
        triagedAt: triaged ? now : null,
        triageReason:
          act.act === 'dismiss' || act.act === 'duplicate' ? (act.reason ?? null) : null,
        duplicateOf: act.act === 'duplicate' ? act.duplicateOf : null,
        linkedIssueId: issue ? issue.id : null,
      })
      .where(inArray(agentReports.id, ids));
    if (issue) await recordFiled(tx, issue, ids, actor);
    return {
      ok: true,
      effect: { act: act.act, triage: to, reports: ids, issue, untouched },
    };
  });
}

async function recordFiled(
  tx: Tx,
  issue: { id: string; created: boolean },
  reportIds: string[],
  actor: ReportActor,
) {
  await writeRecordEvent(
    {
      issueId: issue.id,
      actor: { type: 'user', id: actor.userId, agency: actor.agency },
      kind: 'decision',
      contract: 1,
      fields: [
        {
          key: 'lead',
          value: `${reportIds.length} agent report(s) filed into this issue as its evidence`,
        },
        { key: 'agent-reports', value: reportIds.join(', ') },
        { key: 'outcome', value: issue.created ? 'filed' : 'linked' },
      ],
    },
    tx,
  );
}

/** The refusal an issue delete meets while reports are filed into it, else null. */
export async function issueDeleteRefusal(issue: {
  id: string;
  projectId: string;
  issSeq: number;
}): Promise<Refusal | null> {
  const rows = await db
    .select({ id: agentReports.id })
    .from(agentReports)
    .where(eq(agentReports.linkedIssueId, issue.id))
    .orderBy(asc(agentReports.createdAt));
  if (rows.length === 0) return null;
  const key = formatIssueRef(await activeIssuePrefix(issue.projectId), issue.issSeq);
  return filedIntoIssueRefusal(
    key,
    rows.map((r) => r.id),
  );
}

export type { AgentReportKind, AgentReportSeverity, AgentReportTarget };

/** An agent report promoted to a feedback is triaged as filed, naming who filed it. */
export async function markReportFiled(
  tx: Tx,
  reportId: string,
  filed: { feedbackId: string; by: string; agency: ActorAgency },
): Promise<void> {
  await tx
    .update(agentReports)
    .set({
      feedbackId: filed.feedbackId,
      triage: 'filed',
      triagedBy: filed.by,
      triagedAgency: filed.agency,
      triagedAt: new Date(),
    })
    .where(eq(agentReports.id, reportId));
}
