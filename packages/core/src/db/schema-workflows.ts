import { OBSERVATION_SOURCES } from '@forge/contracts/workflow-health';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { issues } from './schema-issues.js';
import { projects } from './schema-projects.js';

export const projectWorkflows = pgTable(
  'project_workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    flow: text('flow').notNull(),
    kind: text('kind').notNull(),
    revision: integer('revision').notNull(),
    document: jsonb('document').notNull(),
    // cm:why the design lifecycle is the server's, never the document's: the master writes the
    // drawing, the approver moves this, so a write cannot carry its own approval
    designStatus: text('design_status'),
    designFingerprint: text('design_fingerprint'),
    approvedRevision: integer('approved_revision'),
    writtenByUser: uuid('written_by_user')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    flowUq: uniqueIndex('project_workflows_flow_uq').on(t.projectId, t.flow),
    projectIdx: index('project_workflows_project_idx').on(t.projectId, t.kind),
    kindChk: check('project_workflows_kind_chk', sql`${t.kind} IN ('flow', 'state')`),
    revisionChk: check('project_workflows_revision_chk', sql`${t.revision} >= 1`),
    designStatusChk: check(
      'project_workflows_design_status_chk',
      sql`${t.designStatus} IS NULL OR ${t.designStatus} IN ('draft', 'proposed', 'approved', 'returned')`,
    ),
    designApprovedChk: check(
      'project_workflows_design_approved_chk',
      sql`${t.designStatus} IS DISTINCT FROM 'approved' OR ${t.approvedRevision} IS NOT NULL`,
    ),
  }),
);

// cm:why one row per revision a design was put in front of its approver, kept after a later
// revision supersedes it, so "what changed since the approved one" is a read and never a guess
export const projectWorkflowDesigns = pgTable(
  'project_workflow_designs',
  {
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => projectWorkflows.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    document: jsonb('document').notNull(),
    proposedByUser: uuid('proposed_by_user')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
    decision: text('decision'),
    decidedByUser: uuid('decided_by_user').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    reason: text('reason'),
    // cm:why the issue the design is drawn under, named by its proposer: a return reopens it so its
    // master revises the design, and it is never a build link, which would make it wait on itself
    designIssueId: uuid('design_issue_id').references(() => issues.id, { onDelete: 'set null' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workflowId, t.revision] }),
    decisionChk: check(
      'project_workflow_designs_decision_chk',
      sql`${t.decision} IS NULL OR ${t.decision} IN ('approve', 'return')`,
    ),
    decidedChk: check(
      'project_workflow_designs_decided_chk',
      sql`(${t.decision} IS NULL) = (${t.decidedByUser} IS NULL) AND (${t.decision} IS NULL) = (${t.decidedAt} IS NULL)`,
    ),
    reasonChk: check(
      'project_workflow_designs_reason_chk',
      sql`${t.decision} IS DISTINCT FROM 'return' OR ${t.reason} IS NOT NULL`,
    ),
  }),
);

// cm:why an issue names the one workflow it builds, so dispatch can refuse it until that design is
// approved; the row is the link, and an issue with none is not gated
export const workflowBuilds = pgTable(
  'workflow_builds',
  {
    issueId: uuid('issue_id')
      .primaryKey()
      .references(() => issues.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => projectWorkflows.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    linkedByUser: uuid('linked_by_user')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    /** The steps the issue builds, for an issue whose criteria trace no business criterion naming them. */
    stepIds: text('step_ids').array(),
    /** The observed steps it removes or rebuilds: nodes of the latest observation the design does not hold. */
    observedStepIds: text('observed_step_ids').array(),
  },
  (t) => ({
    workflowIdx: index('workflow_builds_workflow_idx').on(t.workflowId),
  }),
);

// What the code holds, read by an agent at one commit against the approved design revision (REQ-17
// BC-21): its own layer, never written into project_workflows or project_workflow_designs; a reading
// at a commit already read replaces the earlier one
export const projectWorkflowObservations = pgTable(
  'project_workflow_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => projectWorkflows.id, { onDelete: 'cascade' }),
    atSha: text('at_sha').notNull(),
    revision: integer('revision').notNull(),
    document: jsonb('document').notNull(),
    source: text('source', { enum: OBSERVATION_SOURCES }).notNull(),
    writtenBy: uuid('written_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    writtenByAgency: text('written_by_agency', { enum: ['human', 'agent'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workflowShaUq: uniqueIndex('project_workflow_observations_sha_uq').on(t.workflowId, t.atSha),
    projectIdx: index('project_workflow_observations_project_idx').on(
      t.projectId,
      t.workflowId,
      t.createdAt,
    ),
    shaChk: check('project_workflow_observations_sha_chk', sql`${t.atSha} ~ '^[0-9a-f]{40}$'`),
    revisionChk: check('project_workflow_observations_revision_chk', sql`${t.revision} >= 1`),
    sourceChk: check(
      'project_workflow_observations_source_chk',
      sql`${t.source} IN ('observer', 'migrated')`,
    ),
    agencyChk: check(
      'project_workflow_observations_agency_chk',
      sql`${t.writtenByAgency} IN ('human', 'agent')`,
    ),
  }),
);
