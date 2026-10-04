import { MOCKUP_KINDS, MOCKUP_STATUSES } from '@forge/contracts/mockups';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
import { feedback } from './schema-feedback.js';
import { issues } from './schema-issues.js';
import { projects } from './schema-projects.js';
import { requirementRevisions, requirements } from './schema-requirements.js';
import { actorAgencies } from './schema-vocabulary.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// cm:why a mockup (MK-n, ISS-78) is a proposal about exactly one target, as feedback is about one:
// a requirement at the revision it was proposed against, a feedback item, or an issue; its bytes
// live in the one attachment store and never change, a person accepts or returns it, and an
// accepted requirement mockup is pinned by the next baseline beside the designs; migration 0370's
// trigger refuses a content edit or a status move off that path as MOCKUP_IMMUTABLE
export const mockups = pgTable(
  'mockups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    mockupSeq: integer('mockup_seq').notNull(),
    requirementId: uuid('requirement_id').references((): AnyPgColumn => requirements.id, {
      onDelete: 'cascade',
    }),
    revision: integer('revision'),
    feedbackId: uuid('feedback_id').references((): AnyPgColumn => feedback.id, {
      onDelete: 'cascade',
    }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: MOCKUP_KINDS }).notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    caption: text('caption'),
    storagePath: text('storage_path').notNull(),
    status: text('status', { enum: MOCKUP_STATUSES }).notNull().default('proposed'),
    proposedBy: uuid('proposed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    proposedAgency: text('proposed_agency', { enum: actorAgencies }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    reason: text('reason'),
  },
  (t) => ({
    seqUq: uniqueIndex('mockups_project_seq_uq').on(t.projectId, t.mockupSeq),
    revisionFk: foreignKey({
      name: 'mockups_revision_fk',
      columns: [t.requirementId, t.revision],
      foreignColumns: [requirementRevisions.requirementId, requirementRevisions.revision],
    }).onDelete('cascade'),
    requirementIdx: index('mockups_requirement_idx')
      .on(t.projectId, t.requirementId)
      .where(sql`requirement_id IS NOT NULL`),
    feedbackIdx: index('mockups_feedback_idx')
      .on(t.projectId, t.feedbackId)
      .where(sql`feedback_id IS NOT NULL`),
    issueIdx: index('mockups_issue_idx')
      .on(t.projectId, t.issueId)
      .where(sql`issue_id IS NOT NULL`),
    targetChk: check(
      'mockups_target_chk',
      sql`num_nonnulls(${t.requirementId}, ${t.feedbackId}, ${t.issueId}) = 1 AND (${t.requirementId} IS NULL) = (${t.revision} IS NULL)`,
    ),
    kindChk: check('mockups_kind_chk', sql`${t.kind} IN (${inList(MOCKUP_KINDS)})`),
    statusChk: check('mockups_status_chk', sql`${t.status} IN (${inList(MOCKUP_STATUSES)})`),
    agencyChk: check('mockups_agency_chk', sql`${t.proposedAgency} IN (${inList(actorAgencies)})`),
    sizeChk: check('mockups_size_chk', sql`${t.size} > 0`),
    seqChk: check('mockups_seq_chk', sql`${t.mockupSeq} >= 1`),
    decidedChk: check(
      'mockups_decided_chk',
      sql`${t.status} = 'proposed' OR (${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
    ),
    returnedChk: check(
      'mockups_returned_reason_chk',
      sql`${t.status} <> 'returned' OR ${t.reason} ~ '[^[:space:]]'`,
    ),
  }),
);
