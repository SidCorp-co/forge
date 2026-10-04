import {
  AGENT_REPORT_KINDS,
  AGENT_REPORT_SEVERITIES,
  AGENT_REPORT_TARGETS,
  type AgentReportKind,
  type AgentReportSeverity,
  type AgentReportTarget,
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
import { issues, jobs, pipelineRuns, projects } from './schema.js';
import { feedback } from './schema-feedback.js';

export const agentReportKinds = AGENT_REPORT_KINDS;
export const agentReportSeverities = AGENT_REPORT_SEVERITIES;
export const agentReportTargets = AGENT_REPORT_TARGETS;
export type { AgentReportKind, AgentReportSeverity, AgentReportTarget };

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
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    // ISS-712 — issue the report was curated INTO (distinct from `issueId`,
    // which is the SOURCE issue the agent was working on when it reported).
    // Set only via the `review` action's explicit linkedIssueId param.
    linkedIssueId: uuid('linked_issue_id').references((): AnyPgColumn => issues.id, {
      onDelete: 'set null',
    }),
    // cm:why ISS-93: the report's other route, the feedback item it was promoted into; exclusive
    // with `linked_issue_id`, one report per item, and a promoted report stays reviewed
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
    promotedReviewedChk: check(
      'agent_reports_promoted_reviewed_chk',
      sql`${t.feedbackId} IS NULL OR ${t.reviewedAt} IS NOT NULL`,
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
  run: one(pipelineRuns, { fields: [agentReports.runId], references: [pipelineRuns.id] }),
  job: one(jobs, { fields: [agentReports.jobId], references: [jobs.id] }),
}));
