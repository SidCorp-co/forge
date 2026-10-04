import {
  FEEDBACK_CASE_OWNERS,
  FEEDBACK_DECISIONS,
  FEEDBACK_KINDS,
  FEEDBACK_ROUTES,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
  FEEDBACK_TRIAGE_ROUTES,
} from '@forge/contracts/feedback';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { contractVersions } from './schema-ecosystem.js';
import { issues } from './schema-issues.js';
import { pipelineRuns } from './schema-pipeline.js';
import { projects } from './schema-projects.js';
import { requirements } from './schema-requirements.js';
import { suggestions } from './schema-suggestions.js';
import { projectWorkflows } from './schema-workflows.js';

export {
  FEEDBACK_DECISIONS,
  FEEDBACK_KINDS,
  FEEDBACK_ROUTES,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
} from '@forge/contracts/feedback';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// cm:why FB-n (workflow feedback-lifecycle rev 2): the stored status is only what a person decided;
// planned and resolved are read from the linked work (Q1). A keyed row is never deleted: a
// redaction (UC15) empties its text and keeps the row so every link to it still resolves
export const feedback = pgTable(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fbSeq: integer('fb_seq').notNull(),
    kind: text('kind', { enum: FEEDBACK_KINDS }).notNull(),
    severity: text('severity', { enum: FEEDBACK_SEVERITIES }).notNull().default('medium'),
    title: text('title').notNull(),
    body: text('body'),
    /** Where it was seen; with no target key it is the screen the item is about. */
    whereSeen: text('where_seen'),
    // cm:why an exclusive arc of real foreign keys; `no action` so a target is never deleted out
    // from under a keyed row, while a project's cascade still removes both
    requirementId: uuid('requirement_id').references((): AnyPgColumn => requirements.id, {
      onDelete: 'no action',
    }),
    issueId: uuid('issue_id').references((): AnyPgColumn => issues.id, { onDelete: 'no action' }),
    releaseRunId: uuid('release_run_id').references((): AnyPgColumn => pipelineRuns.id, {
      onDelete: 'no action',
    }),
    workflowId: uuid('workflow_id').references((): AnyPgColumn => projectWorkflows.id, {
      onDelete: 'no action',
    }),
    /** On a workflow target, the one step or edge of it the item is about; none keeps it workflow-level. */
    stepId: text('step_id'),
    edgeFrom: text('edge_from'),
    edgeTo: text('edge_to'),
    edgeLabel: text('edge_label'),
    // cm:why the fifth arc member is a provider's contract version, filed by core alone (E3); its
    // deadline is that version's approval plus the provider's commitment window
    contractProviderProjectId: uuid('contract_provider_project_id').references(() => projects.id, {
      onDelete: 'cascade',
    }),
    contractSlug: text('contract_slug'),
    contractVersion: text('contract_version'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    status: text('status', { enum: FEEDBACK_STATUSES }).notNull().default('new'),
    route: text('route', { enum: FEEDBACK_ROUTES }),
    routedIssueId: uuid('routed_issue_id').references((): AnyPgColumn => issues.id, {
      onDelete: 'no action',
    }),
    routedRequirementId: uuid('routed_requirement_id').references(
      (): AnyPgColumn => requirements.id,
      { onDelete: 'no action' },
    ),
    routedSuggestionId: uuid('routed_suggestion_id').references((): AnyPgColumn => suggestions.id, {
      onDelete: 'no action',
    }),
    duplicateOf: uuid('duplicate_of').references((): AnyPgColumn => feedback.id, {
      onDelete: 'no action',
    }),
    answer: text('answer'),
    reportedBy: uuid('reported_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reporterAgency: text('reporter_agency', { enum: ['human', 'agent'] }).notNull(),
    /** The project's data policy scrubbed title and body on write; `redactions` counts what it replaced. */
    scrubbed: boolean('scrubbed').notNull().default(false),
    redactions: integer('redactions').notNull().default(0),
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
    redactedBy: uuid('redacted_by').references(() => users.id, { onDelete: 'restrict' }),
    // cm:why one item per consumer per breaking contract version (E3), held by a unique key the filer
    // names, so a retried approval cannot file a twin
    dedupKey: text('dedup_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    arcChk: check(
      'feedback_arc_chk',
      sql`num_nonnulls(${t.requirementId}, ${t.issueId}, ${t.releaseRunId}, ${t.workflowId}, ${t.contractVersion}) = 1 OR (num_nonnulls(${t.requirementId}, ${t.issueId}, ${t.releaseRunId}, ${t.workflowId}, ${t.contractVersion}) = 0 AND ${t.whereSeen} IS NOT NULL)`,
    ),
    nodeChk: check(
      'feedback_node_chk',
      sql`(${t.stepId} IS NULL AND ${t.edgeFrom} IS NULL AND ${t.edgeTo} IS NULL AND ${t.edgeLabel} IS NULL) OR (${t.workflowId} IS NOT NULL AND ((${t.stepId} IS NOT NULL AND ${t.edgeFrom} IS NULL AND ${t.edgeTo} IS NULL AND ${t.edgeLabel} IS NULL) OR (${t.stepId} IS NULL AND ${t.edgeFrom} IS NOT NULL AND ${t.edgeTo} IS NOT NULL)))`,
    ),
    contractTargetChk: check(
      'feedback_contract_target_chk',
      sql`num_nonnulls(${t.contractProviderProjectId}, ${t.contractSlug}, ${t.contractVersion}) IN (0, 3)`,
    ),
    dueChk: check('feedback_due_chk', sql`${t.dueAt} IS NULL OR ${t.contractVersion} IS NOT NULL`),
    contractFk: foreignKey({
      name: 'feedback_contract_version_fk',
      columns: [t.contractProviderProjectId, t.contractSlug, t.contractVersion],
      foreignColumns: [
        contractVersions.providerProjectId,
        contractVersions.contractSlug,
        contractVersions.version,
      ],
    }),
    kindChk: check('feedback_kind_chk', sql`${t.kind} IN (${inList(FEEDBACK_KINDS)})`),
    severityChk: check(
      'feedback_severity_chk',
      sql`${t.severity} IN (${inList(FEEDBACK_SEVERITIES)})`,
    ),
    statusChk: check('feedback_status_chk', sql`${t.status} IN (${inList(FEEDBACK_STATUSES)})`),
    routeChk: check(
      'feedback_route_chk',
      sql`(${t.route} IS NULL AND num_nonnulls(${t.routedIssueId}, ${t.routedRequirementId}, ${t.routedSuggestionId}, ${t.duplicateOf}, ${t.answer}) = 0)
        OR (${t.route} = 'issue' AND ${t.routedIssueId} IS NOT NULL AND num_nonnulls(${t.routedRequirementId}, ${t.routedSuggestionId}, ${t.duplicateOf}, ${t.answer}) = 0)
        OR (${t.route} = 'revision' AND ${t.routedSuggestionId} IS NOT NULL AND num_nonnulls(${t.routedIssueId}, ${t.routedRequirementId}, ${t.duplicateOf}, ${t.answer}) = 0)
        OR (${t.route} = 'new_requirement' AND ${t.routedRequirementId} IS NOT NULL AND num_nonnulls(${t.routedIssueId}, ${t.routedSuggestionId}, ${t.duplicateOf}, ${t.answer}) = 0)
        OR (${t.route} = 'answer' AND ${t.answer} ~ '[^[:space:]]' AND num_nonnulls(${t.routedIssueId}, ${t.routedRequirementId}, ${t.routedSuggestionId}, ${t.duplicateOf}) = 0)
        OR (${t.route} = 'duplicate' AND ${t.duplicateOf} IS NOT NULL AND num_nonnulls(${t.routedIssueId}, ${t.routedRequirementId}, ${t.routedSuggestionId}, ${t.answer}) = 0)`,
    ),
    // a triaged item's route is written by its case, so triaged may hold none yet
    statusRouteChk: check(
      'feedback_status_route_chk',
      sql`${t.status} <> 'new' OR ${t.route} IS NULL`,
    ),
    duplicateSelfChk: check(
      'feedback_duplicate_self_chk',
      sql`${t.duplicateOf} IS NULL OR ${t.duplicateOf} <> ${t.id}`,
    ),
    redactedChk: check(
      'feedback_redacted_chk',
      sql`${t.redactedAt} IS NULL OR (${t.body} IS NULL AND ${t.redactedBy} IS NOT NULL)`,
    ),
    agencyChk: check(
      'feedback_reporter_agency_chk',
      sql`${t.reporterAgency} IN ('human', 'agent')`,
    ),
    seqUq: uniqueIndex('feedback_project_seq_uq').on(t.projectId, t.fbSeq),
    dedupUq: uniqueIndex('feedback_project_dedup_uq')
      .on(t.projectId, t.dedupKey)
      .where(sql`dedup_key IS NOT NULL`),
    statusIdx: index('feedback_project_status_idx').on(t.projectId, t.status),
    routedIssueIdx: index('feedback_routed_issue_idx')
      .on(t.routedIssueId)
      .where(sql`routed_issue_id IS NOT NULL`),
    duplicateIdx: index('feedback_duplicate_of_idx')
      .on(t.duplicateOf)
      .where(sql`duplicate_of IS NOT NULL`),
  }),
);

// cm:why a decision is a row, not an overwrite (domain-entities.md "Records and audit"): a re-triage
// after a reopen keeps the route it replaced. Insert-only by trigger, removed only with its item
export const feedbackDecisions = pgTable(
  'feedback_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    feedbackId: uuid('feedback_id')
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    decision: text('decision', { enum: FEEDBACK_DECISIONS }).notNull(),
    route: text('route', { enum: FEEDBACK_ROUTES }),
    /** What the route points at, by key (ISS-12, REQ-3, FB-4), as it read when decided. */
    carrier: text('carrier'),
    reason: text('reason'),
    decidedBy: uuid('decided_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decidedAgency: text('decided_agency', { enum: ['human', 'agent'] }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    fromSuggestionId: uuid('from_suggestion_id').references((): AnyPgColumn => suggestions.id, {
      onDelete: 'no action',
    }),
  },
  (t) => ({
    decisionChk: check(
      'feedback_decisions_decision_chk',
      sql`${t.decision} IN (${inList(FEEDBACK_DECISIONS)})`,
    ),
    routeChk: check(
      'feedback_decisions_route_chk',
      sql`(${t.decision} IN ('triaged', 'routed')) = (${t.route} IS NOT NULL)`,
    ),
    reasonChk: check(
      'feedback_decisions_reason_chk',
      sql`${t.decision} NOT IN ('declined', 'reopened') OR ${t.reason} ~ '[^[:space:]]'`,
    ),
    agencyChk: check(
      'feedback_decisions_agency_chk',
      sql`${t.decidedAgency} IN ('human', 'agent')`,
    ),
    feedbackIdx: index('feedback_decisions_feedback_idx').on(t.feedbackId, t.decidedAt),
  }),
);

// cm:why a reporter's screenshot is reporter data (UC15): stored beside its item, flagged when the
// project's data policy is on, and removed with the bytes on a redaction
export const feedbackAttachments = pgTable(
  'feedback_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    feedbackId: uuid('feedback_id')
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    storagePath: text('storage_path').notNull(),
    flagged: boolean('flagged').notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    feedbackIdx: index('feedback_attachments_feedback_idx').on(t.feedbackId),
  }),
);

// workflow requirement-to-delivery step `fb-case`: one case per feedback item, opened by triage with
// the route it decided, owned by the project master for an issue route and by the BA otherwise; it
// assigns writing the route, due by severity (or the commitment window), and a re-triage re-opens it
export const feedbackCases = pgTable(
  'feedback_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    feedbackId: uuid('feedback_id')
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    route: text('route', { enum: FEEDBACK_TRIAGE_ROUTES }).notNull(),
    owner: text('owner', { enum: FEEDBACK_CASE_OWNERS }).notNull(),
    openedBy: uuid('opened_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    openedAgency: text('opened_agency', { enum: ['human', 'agent'] }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    routedAt: timestamp('routed_at', { withTimezone: true }),
    routedBy: uuid('routed_by').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => ({
    routeChk: check(
      'feedback_cases_route_chk',
      sql`${t.route} IN (${inList(FEEDBACK_TRIAGE_ROUTES)})`,
    ),
    ownerChk: check(
      'feedback_cases_owner_chk',
      sql`${t.owner} IN (${inList(FEEDBACK_CASE_OWNERS)})`,
    ),
    ownerRouteChk: check(
      'feedback_cases_owner_route_chk',
      sql`(${t.route} = 'issue') = (${t.owner} = 'master')`,
    ),
    agencyChk: check(
      'feedback_cases_opened_agency_chk',
      sql`${t.openedAgency} IN ('human', 'agent')`,
    ),
    routedChk: check(
      'feedback_cases_routed_chk',
      sql`(${t.routedAt} IS NULL) = (${t.routedBy} IS NULL)`,
    ),
    feedbackUq: uniqueIndex('feedback_cases_feedback_uq').on(t.feedbackId),
    openIdx: index('feedback_cases_project_open_idx')
      .on(t.projectId, t.dueAt)
      .where(sql`routed_at IS NULL`),
  }),
);
