import {
  AGENT_REPORT_KINDS,
  AGENT_REPORT_SEVERITIES,
  AGENT_REPORT_TARGETS,
  AGENT_REPORT_TRIAGES,
  type AgentReportKind,
  type AgentReportSeverity,
  type AgentReportTarget,
  type AgentReportTriage,
} from '@forge/contracts/agent-reports';
import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { feedback } from './schema-feedback.js';
import { issues } from './schema-issues.js';
import { jobs } from './schema-jobs.js';
import { pipelineRuns } from './schema-pipeline.js';
import { projects } from './schema-projects.js';
import { scheduleRuns } from './schema-schedule-runs.js';
import { actorAgencies } from './schema-vocabulary.js';

export const agentReportKinds = AGENT_REPORT_KINDS;
export const agentReportSeverities = AGENT_REPORT_SEVERITIES;
export const agentReportTargets = AGENT_REPORT_TARGETS;
export const agentReportTriages = AGENT_REPORT_TRIAGES;
export type { AgentReportKind, AgentReportSeverity, AgentReportTarget, AgentReportTriage };

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * What an agent reports about the harness it ran under — friction, a skill gap, a learning. Not a
 * person's product feedback, which owns the word `feedback`.
 */
export const agentReports = pgTable(
  'agent_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references((): AnyPgColumn => issues.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    stage: text('stage'),
    skillName: text('skill_name'),
    skillVersion: integer('skill_version'),
    kind: text('kind', { enum: agentReportKinds }).notNull(),
    severity: text('severity', { enum: agentReportSeverities }).notNull().default('low'),
    target: text('target', { enum: agentReportTargets }).notNull(),
    targetRef: text('target_ref'),
    summary: text('summary').notNull(),
    detail: text('detail'),
    suggestion: text('suggestion'),
    // Server-computed `self_report:<target>:<targetRef|'-'>:<kind>`.
    // Stored for C2 signal accrual + list dedup.
    signalKey: text('signal_key').notNull(),
    // ISS-557 — bare uuid pointing at the agent_session that emitted this report.
    // No hard FK so steward sessions (which have no job row) can link cleanly.
    sessionId: uuid('session_id'),
    // cm:why ISS-113 (design automation rev 1, step report): the fire whose session filed the report,
    // resolved at submit from the session's `scheduleRunId`, so a fire's reports are a join
    scheduleRunId: uuid('schedule_run_id').references((): AnyPgColumn => scheduleRuns.id, {
      onDelete: 'set null',
    }),
    // cm:why ISS-113 (steps triage, file, dismiss; reports_table): one triage value with who, when
    // and why replaces `reviewed_at`, which stood for three outcomes; the shape CHECK below holds
    // each value to the columns it owns, so `filed` has exactly one target
    triage: text('triage', { enum: agentReportTriages }).notNull().default('new'),
    triagedBy: uuid('triaged_by').references(() => users.id, { onDelete: 'restrict' }),
    triagedAgency: text('triaged_agency', { enum: actorAgencies }),
    triagedAt: timestamp('triaged_at', { withTimezone: true }),
    triageReason: text('triage_reason'),
    duplicateOf: uuid('duplicate_of').references((): AnyPgColumn => agentReports.id, {
      onDelete: 'no action',
    }),
    // cm:why ISS-712: the issue a report was filed INTO, distinct from `issueId`, the SOURCE issue the
    // agent was working on. `no action` since ISS-113: deleting that issue would leave a filed report
    // with no target, so the issue delete is refused AGENT_REPORT_FILED_INTO_ISSUE instead
    linkedIssueId: uuid('linked_issue_id').references((): AnyPgColumn => issues.id, {
      onDelete: 'no action',
    }),
    // cm:why ISS-93: the report's other target, the feedback item it was promoted into; exclusive
    // with `linked_issue_id`, one report per item
    feedbackId: uuid('feedback_id').references((): AnyPgColumn => feedback.id, {
      onDelete: 'no action',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    routeChk: check(
      'agent_reports_route_chk',
      sql`num_nonnulls(${t.linkedIssueId}, ${t.feedbackId}) <= 1`,
    ),
    triageChk: check(
      'agent_reports_triage_chk',
      sql`${t.triage} IN (${inList(AGENT_REPORT_TRIAGES)}) AND CASE ${t.triage}
        WHEN 'new' THEN num_nonnulls(${t.triagedBy}, ${t.triagedAgency}, ${t.triagedAt}, ${t.triageReason}, ${t.duplicateOf}, ${t.linkedIssueId}, ${t.feedbackId}) = 0
        WHEN 'filed' THEN ${t.triagedAt} IS NOT NULL AND num_nonnulls(${t.linkedIssueId}, ${t.feedbackId}) = 1 AND ${t.duplicateOf} IS NULL
        WHEN 'dismissed' THEN ${t.triagedAt} IS NOT NULL AND btrim(coalesce(${t.triageReason}, '')) <> '' AND num_nonnulls(${t.duplicateOf}, ${t.linkedIssueId}, ${t.feedbackId}) = 0
        WHEN 'duplicate' THEN ${t.triagedAt} IS NOT NULL AND ${t.duplicateOf} IS NOT NULL AND ${t.duplicateOf} <> ${t.id} AND num_nonnulls(${t.linkedIssueId}, ${t.feedbackId}) = 0
        ELSE false END`,
    ),
    triagedByChk: check(
      'agent_reports_triaged_by_chk',
      sql`(${t.triagedBy} IS NULL) = (${t.triagedAgency} IS NULL) AND (${t.triagedAgency} IS NULL OR ${t.triagedAgency} IN (${inList(actorAgencies)}))`,
    ),
    feedbackUq: uniqueIndex('agent_reports_feedback_uq')
      .on(t.feedbackId)
      .where(sql`feedback_id IS NOT NULL`),
    projectIdIdx: index('agent_reports_project_id_idx').on(t.projectId),
    projectKindIdx: index('agent_reports_project_kind_idx').on(t.projectId, t.kind),
    projectTargetIdx: index('agent_reports_project_target_idx').on(
      t.projectId,
      t.target,
      t.targetRef,
    ),
    signalKeyIdx: index('agent_reports_signal_key_idx').on(t.signalKey),
    createdAtIdx: index('agent_reports_created_at_idx').on(t.createdAt),
    sessionIdx: index('agent_reports_session_id_idx').on(t.sessionId),
    linkedIssueIdIdx: index('agent_reports_linked_issue_id_idx').on(t.linkedIssueId),
    projectTriageIdx: index('agent_reports_project_triage_idx').on(t.projectId, t.triage),
    scheduleRunIdx: index('agent_reports_schedule_run_idx')
      .on(t.scheduleRunId)
      .where(sql`schedule_run_id IS NOT NULL`),
  }),
);

export const agentReportsRelations = relations(agentReports, ({ one }) => ({
  project: one(projects, { fields: [agentReports.projectId], references: [projects.id] }),
  issue: one(issues, { fields: [agentReports.issueId], references: [issues.id] }),
  linkedIssue: one(issues, {
    fields: [agentReports.linkedIssueId],
    references: [issues.id],
  }),
  feedback: one(feedback, { fields: [agentReports.feedbackId], references: [feedback.id] }),
  scheduleRun: one(scheduleRuns, {
    fields: [agentReports.scheduleRunId],
    references: [scheduleRuns.id],
  }),
  run: one(pipelineRuns, { fields: [agentReports.runId], references: [pipelineRuns.id] }),
  job: one(jobs, { fields: [agentReports.jobId], references: [jobs.id] }),
}));
