import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import type { ReleaseNotes } from '@forge/contracts/release-notes';
import { relations, type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { BODY_FORMATS } from '../body/formats.js';
import { activityLog } from './schema-activity.js';
import { users } from './schema-auth.js';
import { comments } from './schema-comments.js';
import { devices } from './schema-devices.js';
import { labels } from './schema-labels.js';
import { pipelineRuns } from './schema-pipeline.js';
import { projects } from './schema-projects.js';
import { requirementRevisions, requirements } from './schema-requirements.js';
import { scheduleRuns } from './schema-schedule-runs.js';
import { suggestions } from './schema-suggestions.js';
import { identSearchColumn } from './schema-types.js';

export interface IssueBranchOverride {
  baseBranch?: string | null;
  targetBranch?: string | null;
}

export const issuePrefixAliases = pgTable(
  'issue_prefix_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references((): AnyPgColumn => projects.id, {
      onDelete: 'set null',
    }),
    prefix: text('prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    prefixUq: uniqueIndex('issue_prefix_aliases_prefix_uq').on(t.prefix),
    projectPrefixUq: unique('issue_prefix_aliases_project_prefix_uq').on(t.projectId, t.prefix),
    prefixShape: check(
      'issue_prefix_aliases_prefix_shape',
      sql`${t.prefix} ~ '^[A-Z][A-Z0-9]{1,5}$' AND ${t.prefix} <> 'ISS'`,
    ),
  }),
);

/**
 * What a `needs_info` park is stopped on. `needs_answer` is a question; the other two are the old
 * `waiting` park's kinds, which folded into `needs_info` with their kind kept (ISS-54).
 */
export const waitingKinds = ['needs_answer', 'needs_decision', 'needs_resource'] as const;

export type WaitingKind = (typeof waitingKinds)[number];

/**
 * The ten statuses of workflow `issue-lifecycle`, declared once in contracts. A status answers only
 * "who is it waiting on"; a run's step is progress inside `in_progress`, in `issue_work_state`.
 */
export const issueStatuses = ISSUE_STATUSES;

export type IssueStatus = (typeof issueStatuses)[number];

export const issuePriorities = ['critical', 'high', 'medium', 'low', 'none'] as const;

export type IssuePriority = (typeof issuePriorities)[number];

// ISS-42 C2 — t-shirt sizing for issue scope. Mirrored by the
// `issues_complexity_chk` CHECK constraint (migration 0046). NULL means
// "not yet sized".
export const issueComplexities = ['xs', 's', 'm', 'l', 'xl'] as const;

export type IssueComplexity = (typeof issueComplexities)[number];

export const issueSources = ['manual', 'github', 'sentry'] as const;

export type IssueSource = (typeof issueSources)[number];

export const issueCreationChannels = ['web', 'mcp', 'pipeline', 'schedule', 'system'] as const;

export type IssueCreationChannel = (typeof issueCreationChannels)[number];

export const projectIssCounters = pgTable('project_iss_counters', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  nextSeq: integer('next_seq').notNull().default(1),
});

export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issSeq: integer('iss_seq').notNull().default(0),
    title: text('title').notNull(),
    description: text('description'),
    descriptionFormat: text('description_format', { enum: BODY_FORMATS })
      .notNull()
      .default('markdown'),
    status: text('status', { enum: issueStatuses }).notNull().default('open'),
    priority: text('priority', { enum: issuePriorities }).notNull().default('medium'),
    category: text('category'),
    // Set by webhook/MCP imports; NULL when `createdById` covers the actor.
    reportedBy: text('reported_by'),
    createdVia: text('created_via', { enum: issueCreationChannels }),
    detectorKey: text('detector_key'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The paired box whose credential filed it, `createdById` its holder; NULL for an account's own write. */
    createdByDeviceId: uuid('created_by_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    mergedCommitSha: text('merged_commit_sha'),
    mergedLanding: text('merged_landing'),
    mergedTarget: text('merged_target'),
    // ISS-42 C2 — t-shirt sizing (xs/s/m/l/xl) for scoping. NULL = unsized.
    complexity: text('complexity', { enum: issueComplexities }),
    reopenCount: integer('reopen_count').notNull().default(0),
    waitingKind: text('waiting_kind', { enum: waitingKinds }),
    source: text('source', { enum: issueSources }).notNull().default('manual'),
    externalId: text('external_id'),
    plan: text('plan'),
    acceptanceCriteria: text('acceptance_criteria'),
    sessionContext: jsonb('session_context'),
    // ISS-199 — user-facing release notes. Written by forge-clarify per
    // issue, read by forge-release at close time to append a CHANGELOG.md
    // `## [Unreleased]` bullet. Shape validated at the app layer; see
    // `release-notes.ts` for the zod schema.
    releaseNotes: jsonb('release_notes').$type<ReleaseNotes | null>(),
    // ISS-137 — Layer 2 branch config (per-issue override) lives here under
    // `branchConfig`. Free-form jsonb so other per-issue settings can land
    // here later without further migrations. NULL = no override.
    metadata: jsonb('metadata').$type<
      | ({
          branchConfig?: IssueBranchOverride | null;
        } & Record<string, unknown>)
      | null
    >(),
    releaseBatchRunId: uuid('release_batch_run_id').references(() => pipelineRuns.id, {
      onDelete: 'set null',
    }),
    // cm:why optional: a maintenance issue serves no requirement. planned_revision is the requirement
    // revision the plan was written against, set when the plan is written (ISS-57)
    requirementId: uuid('requirement_id').references(() => requirements.id),
    plannedRevision: integer('planned_revision'),
    // cm:why which baseline at planned_revision the plan read: a re-pin onto newly approved designs
    // writes a later one at the same revision, and a plan that predates it has changed since (ISS-86)
    plannedBaselineSeq: integer('planned_baseline_seq'),
    // cm:why an issue filed as an accepted suggestion's effect points back at it, as a revision does
    // (workflow suggestion-lifecycle step accepted)
    fromSuggestionId: uuid('from_suggestion_id').references((): AnyPgColumn => suggestions.id, {
      onDelete: 'no action',
    }),
    // cm:why the fire an issue was filed in (design automation rev 1, step settle; ISS-114): resolved
    // at create through the creating session's fire, or written by the fire that filed it inline, so
    // Fire.produced counts issues by join; a person's own create carries none
    scheduleRunId: uuid('schedule_run_id').references((): AnyPgColumn => scheduleRuns.id, {
      onDelete: 'set null',
    }),
    identSearch: identSearchColumn(
      (): SQL =>
        sql`left(${issues.title} || ' ' || coalesce(${issues.description}, '') || ' ' || coalesce(${issues.plan}, '') || ' ' || coalesce(${issues.acceptanceCriteria}, ''), 100000)`,
    ),
    // ISS-1237 — set = archived; which reads still answer it is `issues/archive-readers.test.ts`.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    descriptionFormatChk: check(
      'issues_description_format_chk',
      sql`${t.descriptionFormat} IN ('markdown', 'html')`,
    ),
    mergedLandingChk: check(
      'issues_merged_landing_chk',
      sql`${t.mergedLanding} IS NULL OR (${t.mergedAt} IS NOT NULL AND ${t.mergedLanding} ~ '[^[:space:]]' AND char_length(${t.mergedLanding}) <= 2000)`,
    ),
    projectIssSeqUq: uniqueIndex('issues_project_iss_seq_uq').on(t.projectId, t.issSeq),
    projectStatusIdx: index('issues_project_status_idx').on(t.projectId, t.status),
    assigneeIdx: index('issues_assignee_idx').on(t.assigneeId),
    projectSourceExternalIdUq: uniqueIndex('issues_project_source_external_id_uq')
      .on(t.projectId, t.source, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    identSearchIdx: index('issues_ident_search_idx').using('gin', t.identSearch),
    titleTrgmIdx: index('issues_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
    descriptionTrgmIdx: index('issues_description_trgm_idx').using(
      'gin',
      sql`${t.description} gin_trgm_ops`,
    ),
    planTrgmIdx: index('issues_plan_trgm_idx').using('gin', sql`${t.plan} gin_trgm_ops`),
    acceptanceCriteriaTrgmIdx: index('issues_acceptance_criteria_trgm_idx').using(
      'gin',
      sql`${t.acceptanceCriteria} gin_trgm_ops`,
    ),
    projectCreatedAtIdx: index('issues_project_created_at_idx').on(t.projectId, t.createdAt),
    scheduleRunIdx: index('issues_schedule_run_idx')
      .on(t.scheduleRunId)
      .where(sql`schedule_run_id IS NOT NULL`),
    projectUpdatedAtIdx: index('issues_project_updated_at_idx').on(t.projectId, t.updatedAt),
    releaseBatchRunIdIdx: index('issues_release_batch_run_id_idx')
      .on(t.releaseBatchRunId)
      .where(sql`release_batch_run_id IS NOT NULL`),
    archivedAtIdx: index('issues_archived_at_idx').on(t.archivedAt),
    requirementIdx: index('issues_requirement_idx')
      .on(t.requirementId)
      .where(sql`requirement_id IS NOT NULL`),
    plannedRevisionFk: foreignKey({
      name: 'issues_planned_revision_fk',
      columns: [t.requirementId, t.plannedRevision],
      foreignColumns: [requirementRevisions.requirementId, requirementRevisions.revision],
    }),
    plannedRevisionChk: check(
      'issues_planned_revision_chk',
      sql`${t.plannedRevision} IS NULL OR ${t.requirementId} IS NOT NULL`,
    ),
    plannedBaselineChk: check(
      'issues_planned_baseline_chk',
      sql`${t.plannedBaselineSeq} IS NULL OR (${t.plannedRevision} IS NOT NULL AND ${t.plannedBaselineSeq} >= 1)`,
    ),
  }),
);

export const issueLabels = pgTable(
  'issue_labels',
  {
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.issueId, t.labelId] }),
    labelIdx: index('issue_labels_label_id_idx').on(t.labelId),
    primaryUq: uniqueIndex('issue_labels_primary_uq').on(t.issueId).where(sql`is_primary = true`),
  }),
);

export const issuesRelations = relations(issues, ({ one, many }) => ({
  project: one(projects, { fields: [issues.projectId], references: [projects.id] }),
  assignee: one(users, { fields: [issues.assigneeId], references: [users.id] }),
  createdBy: one(users, { fields: [issues.createdById], references: [users.id] }),
  comments: many(comments),
  labels: many(issueLabels),
  activity: many(activityLog),
  attachments: many(issueAttachments),
}));

export const issueAttachments = pgTable(
  'issue_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issueIdx: index('issue_attachments_issue_id_idx').on(t.issueId),
  }),
);

export const issueAttachmentsRelations = relations(issueAttachments, ({ one }) => ({
  issue: one(issues, { fields: [issueAttachments.issueId], references: [issues.id] }),
  uploader: one(users, { fields: [issueAttachments.uploaderId], references: [users.id] }),
}));

export const issueLabelsRelations = relations(issueLabels, ({ one }) => ({
  issue: one(issues, { fields: [issueLabels.issueId], references: [issues.id] }),
  label: one(labels, { fields: [issueLabels.labelId], references: [labels.id] }),
}));

export const issueDependencyKinds = [
  'blocks',
  'relates',
  'duplicates',
  'parent',
  'decomposes',
] as const;

export type IssueDependencyKind = (typeof issueDependencyKinds)[number];

export const issueDependencies = pgTable(
  'issue_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fromIssueId: uuid('from_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    toIssueId: uuid('to_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: issueDependencyKinds }).notNull(),
    reason: text('reason'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
  },
  (t) => ({
    uniqueEdgeIdx: uniqueIndex('issue_dependencies_unique_edge_idx').on(
      t.projectId,
      t.fromIssueId,
      t.toIssueId,
      t.kind,
    ),
    projectFromIdx: index('issue_dependencies_project_from_idx').on(t.projectId, t.fromIssueId),
    projectToIdx: index('issue_dependencies_project_to_idx').on(t.projectId, t.toIssueId),
  }),
);

export const issueDependenciesRelations = relations(issueDependencies, ({ one }) => ({
  project: one(projects, {
    fields: [issueDependencies.projectId],
    references: [projects.id],
  }),
  fromIssue: one(issues, {
    fields: [issueDependencies.fromIssueId],
    references: [issues.id],
    relationName: 'issueDependenciesFrom',
  }),
  toIssue: one(issues, {
    fields: [issueDependencies.toIssueId],
    references: [issues.id],
    relationName: 'issueDependenciesTo',
  }),
  createdBy: one(users, {
    fields: [issueDependencies.createdById],
    references: [users.id],
  }),
}));
