import type { BaselineReadiness } from '@forge/contracts/requirements';
import { REQUIREMENT_CRITERION_FORMS } from '@forge/contracts/suggestions';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { projects, users } from './schema.js';
import { contractVersions } from './schema-ecosystem.js';
import { suggestions } from './schema-suggestions.js';
import { projectWorkflowDesigns, projectWorkflows } from './schema-workflows.js';

export const REQUIREMENT_STATUSES = ['draft', 'agreed', 'accepted', 'dropped'] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const REVISION_STATES = ['draft', 'proposed', 'current', 'superseded'] as const;
export type RevisionState = (typeof REVISION_STATES)[number];

export const CRITERION_FORMS = REQUIREMENT_CRITERION_FORMS;
export type CriterionForm = (typeof CRITERION_FORMS)[number];

// cm:why the stored status holds only what a person decides (workflow requirement-lifecycle); in
// delivery and delivered are phases of the requirement_delivery view, never written (Q1)
export const requirements = pgTable(
  'requirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    reqSeq: integer('req_seq').notNull(),
    title: text('title').notNull(),
    status: text('status', { enum: REQUIREMENT_STATUSES }).notNull().default('draft'),
    // cm:why the head is the current revision only: a draft or proposed revision is never the head
    currentRevision: integer('current_revision'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    seqUq: uniqueIndex('requirements_project_seq_uq').on(t.projectId, t.reqSeq),
    statusIdx: index('requirements_project_status_idx').on(t.projectId, t.status),
    statusChk: check(
      'requirements_status_chk',
      sql`${t.status} IN ('draft', 'agreed', 'accepted', 'dropped')`,
    ),
    seqChk: check('requirements_seq_chk', sql`${t.reqSeq} >= 1`),
    headFk: foreignKey({
      name: 'requirements_head_fk',
      columns: [t.id, t.currentRevision],
      foreignColumns: [requirementRevisions.requirementId, requirementRevisions.revision],
    }),
    agreedHeadChk: check(
      'requirements_agreed_head_chk',
      sql`${t.status} NOT IN ('agreed', 'accepted') OR ${t.currentRevision} IS NOT NULL`,
    ),
  }),
);

// cm:why insert-only evidence: content is written while a revision is a draft and frozen once it is
// proposed; the trigger in migration 0349 refuses anything else as REVISION_IMMUTABLE
export const requirementRevisions = pgTable(
  'requirement_revisions',
  {
    requirementId: uuid('requirement_id')
      .notNull()
      .references((): AnyPgColumn => requirements.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    state: text('state', { enum: REVISION_STATES }).notNull().default('draft'),
    baseRevision: integer('base_revision'),
    spec: jsonb('spec').notNull(),
    specVersion: integer('spec_version').notNull().default(1),
    tldr: text('tldr'),
    changeSummary: text('change_summary'),
    reason: text('reason').notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    proposedAt: timestamp('proposed_at', { withTimezone: true }),
    proposedBy: uuid('proposed_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    returnReason: text('return_reason'),
    // cm:why an accepted suggestion's effect points back at it (suggestion-lifecycle step accepted)
    fromSuggestionId: uuid('from_suggestion_id').references((): AnyPgColumn => suggestions.id, {
      onDelete: 'no action',
    }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requirementId, t.revision] }),
    oneCurrentUq: uniqueIndex('requirement_revisions_one_current_uq')
      .on(t.requirementId)
      .where(sql`state = 'current'`),
    oneOpenUq: uniqueIndex('requirement_revisions_one_open_uq')
      .on(t.requirementId)
      .where(sql`state IN ('draft', 'proposed')`),
    stateChk: check(
      'requirement_revisions_state_chk',
      sql`${t.state} IN ('draft', 'proposed', 'current', 'superseded')`,
    ),
    revisionChk: check('requirement_revisions_revision_chk', sql`${t.revision} >= 1`),
    reasonChk: check('requirement_revisions_reason_chk', sql`${t.reason} ~ '[^[:space:]]'`),
    decidedChk: check(
      'requirement_revisions_decided_chk',
      sql`${t.state} NOT IN ('current', 'superseded') OR (${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
    ),
    baseChk: check(
      'requirement_revisions_base_chk',
      sql`${t.baseRevision} IS NULL OR ${t.baseRevision} < ${t.revision}`,
    ),
  }),
);

// cm:why a BC code is stable across revisions; a row is one wording of it, live from since_revision
// until retired_revision, so the criteria of revision n are the rows whose interval holds n
export const requirementCriteria = pgTable(
  'requirement_criteria',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requirementId: uuid('requirement_id')
      .notNull()
      .references((): AnyPgColumn => requirements.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    body: text('body').notNull(),
    form: text('form', { enum: CRITERION_FORMS }).notNull().default('statement'),
    sinceRevision: integer('since_revision').notNull(),
    retiredRevision: integer('retired_revision'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sinceFk: foreignKey({
      name: 'requirement_criteria_since_fk',
      columns: [t.requirementId, t.sinceRevision],
      foreignColumns: [requirementRevisions.requirementId, requirementRevisions.revision],
    }).onDelete('cascade'),
    liveCodeUq: uniqueIndex('requirement_criteria_live_code_uq')
      .on(t.requirementId, t.code)
      .where(sql`retired_revision IS NULL`),
    wordingUq: uniqueIndex('requirement_criteria_wording_uq').on(
      t.requirementId,
      t.code,
      t.sinceRevision,
    ),
    codeChk: check('requirement_criteria_code_chk', sql`${t.code} ~ '^BC-[1-9][0-9]*$'`),
    formChk: check('requirement_criteria_form_chk', sql`${t.form} IN ('statement', 'scenario')`),
    bodyChk: check('requirement_criteria_body_chk', sql`${t.body} ~ '[^[:space:]]'`),
    retiredChk: check(
      'requirement_criteria_retired_chk',
      sql`${t.retiredRevision} IS NULL OR ${t.retiredRevision} > ${t.sinceRevision}`,
    ),
  }),
);

// cm:why a requirement has its designs before it has issues, so the link cannot be read off workflow_builds
export const requirementWorkflows = pgTable(
  'requirement_workflows',
  {
    requirementId: uuid('requirement_id')
      .notNull()
      .references((): AnyPgColumn => requirements.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => projectWorkflows.id, { onDelete: 'cascade' }),
    linkedBy: uuid('linked_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requirementId, t.workflowId] }),
    workflowIdx: index('requirement_workflows_workflow_idx').on(t.workflowId),
  }),
);

// cm:why the agree is a row, not a column: re-agreeing writes a new baseline and the earlier one
// stays, so "what was agreed at r4" is a read after r5 is agreed
export const requirementBaselines = pgTable(
  'requirement_baselines',
  {
    requirementId: uuid('requirement_id').notNull(),
    revision: integer('revision').notNull(),
    agreedBy: uuid('agreed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    agreedAt: timestamp('agreed_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason'),
    readiness: jsonb('readiness').$type<BaselineReadiness>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requirementId, t.revision] }),
    revisionFk: foreignKey({
      name: 'requirement_baselines_revision_fk',
      columns: [t.requirementId, t.revision],
      foreignColumns: [requirementRevisions.requirementId, requirementRevisions.revision],
    }).onDelete('cascade'),
  }),
);

// cm:why a return is a decision that can happen more than once on one revision (proposed, returned,
// proposed again), so each is its own insert-only row with who, when and why; the revision's
// return_reason keeps only the latest for the draft's author to read
export const requirementReturns = pgTable(
  'requirement_returns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requirementId: uuid('requirement_id').notNull(),
    revision: integer('revision').notNull(),
    returnedBy: uuid('returned_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    returnedAt: timestamp('returned_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason').notNull(),
  },
  (t) => ({
    revisionFk: foreignKey({
      name: 'requirement_returns_revision_fk',
      columns: [t.requirementId, t.revision],
      foreignColumns: [requirementRevisions.requirementId, requirementRevisions.revision],
    }).onDelete('cascade'),
    reasonChk: check('requirement_returns_reason_chk', sql`${t.reason} ~ '[^[:space:]]'`),
    requirementIdx: index('requirement_returns_requirement_idx').on(t.requirementId, t.revision),
  }),
);

// cm:why one pin per linked design revision or contract version at the agree: an exclusive arc over
// two composite keys, each a real foreign key, so a pinned revision or version cannot be deleted
export const requirementBaselinePins = pgTable(
  'requirement_baseline_pins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requirementId: uuid('requirement_id').notNull(),
    revision: integer('revision').notNull(),
    workflowId: uuid('workflow_id'),
    designRevision: integer('design_revision'),
    providerProjectId: uuid('provider_project_id'),
    contractSlug: text('contract_slug'),
    contractVersion: text('contract_version'),
  },
  (t) => ({
    baselineFk: foreignKey({
      name: 'requirement_baseline_pins_baseline_fk',
      columns: [t.requirementId, t.revision],
      foreignColumns: [requirementBaselines.requirementId, requirementBaselines.revision],
    }).onDelete('cascade'),
    designFk: foreignKey({
      name: 'requirement_baseline_pins_design_fk',
      columns: [t.workflowId, t.designRevision],
      foreignColumns: [projectWorkflowDesigns.workflowId, projectWorkflowDesigns.revision],
    }),
    contractFk: foreignKey({
      name: 'requirement_baseline_pins_contract_fk',
      columns: [t.providerProjectId, t.contractSlug, t.contractVersion],
      foreignColumns: [
        contractVersions.providerProjectId,
        contractVersions.contractSlug,
        contractVersions.version,
      ],
    }),
    baselineIdx: index('requirement_baseline_pins_baseline_idx').on(t.requirementId, t.revision),
    arcChk: check(
      'requirement_baseline_pins_arc_chk',
      sql`(num_nonnulls(${t.workflowId}, ${t.designRevision}) = 2 AND num_nonnulls(${t.providerProjectId}, ${t.contractSlug}, ${t.contractVersion}) = 0) OR (num_nonnulls(${t.workflowId}, ${t.designRevision}) = 0 AND num_nonnulls(${t.providerProjectId}, ${t.contractSlug}, ${t.contractVersion}) = 3)`,
    ),
  }),
);

export const DELIVERY_PHASES = ['agreed', 'in_delivery', 'delivered'] as const;
export type DeliveryPhase = (typeof DELIVERY_PHASES)[number];

// cm:why the delivery phase is computed on every read and never written (Q1); the SQL lives in
// migration 0349, and `.existing()` keeps drizzle-kit from re-emitting it
export const requirementDelivery = pgView('requirement_delivery', {
  requirementId: uuid('requirement_id').notNull(),
  phase: text('phase', { enum: DELIVERY_PHASES }),
  liveIssues: integer('live_issues').notNull(),
  startedIssues: integer('started_issues').notNull(),
  closedIssues: integer('closed_issues').notNull(),
}).existing();
