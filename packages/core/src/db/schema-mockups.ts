import {
  MOCKUP_COMMENT_SETTLEMENTS,
  MOCKUP_KINDS,
  MOCKUP_STATUSES,
} from '@forge/contracts/mockups';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  doublePrecision,
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

// a mockup (MK-n, ISS-78) is a proposal about exactly one target, as feedback is about one: a
// requirement at one of its revisions, a feedback item or an issue (REQ-49); its bytes live in the
// one attachment store and never change, and a person accepts or returns it; migration 0370's
// trigger refuses a content edit or a status move off that path as MOCKUP_IMMUTABLE. A returned one
// is answered by its next revision (`revises_id`, `round`), at most one, both fixed once written
// (0509); an accepted requirement mockup is pinned by the next agree or re-pin beside the designs
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
    revisesId: uuid('revises_id').references((): AnyPgColumn => mockups.id, {
      onDelete: 'no action',
    }),
    round: integer('round').notNull().default(1),
  },
  (t) => ({
    seqUq: uniqueIndex('mockups_project_seq_uq').on(t.projectId, t.mockupSeq),
    revisesUq: uniqueIndex('mockups_revises_uq').on(t.revisesId).where(sql`revises_id IS NOT NULL`),
    roundChk: check(
      'mockups_round_chk',
      sql`(${t.revisesId} IS NULL AND ${t.round} = 1) OR (${t.revisesId} IS NOT NULL AND ${t.round} >= 2)`,
    ),
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

// a comment on one mockup (REQ-49 BC-2), pinned to a point (x, y) or a region (x, y, w, h) of its
// frame as fractions 0..1, or to none; its text and pin never change, and the next revision that
// names it settles it once, as answered or resolved (0509's trigger, MOCKUP_COMMENT_IMMUTABLE)
export const mockupComments = pgTable(
  'mockup_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    mockupId: uuid('mockup_id')
      .notNull()
      .references(() => mockups.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    authorAgency: text('author_agency', { enum: actorAgencies }).notNull(),
    body: text('body').notNull(),
    pinX: doublePrecision('pin_x'),
    pinY: doublePrecision('pin_y'),
    pinW: doublePrecision('pin_w'),
    pinH: doublePrecision('pin_h'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settled: text('settled', { enum: MOCKUP_COMMENT_SETTLEMENTS }),
    settledByMockupId: uuid('settled_by_mockup_id').references(() => mockups.id, {
      onDelete: 'cascade',
    }),
    settledNote: text('settled_note'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => ({
    mockupIdx: index('mockup_comments_mockup_idx').on(t.mockupId, t.createdAt),
    agencyChk: check('mockup_comments_agency_chk', sql`${t.authorAgency} IN ('human', 'agent')`),
    bodyChk: check('mockup_comments_body_chk', sql`${t.body} ~ '[^[:space:]]'`),
    pinChk: check(
      'mockup_comments_pin_chk',
      sql`(num_nonnulls(${t.pinX}, ${t.pinY}, ${t.pinW}, ${t.pinH}) IN (0, 2, 4)) AND ((${t.pinX} IS NULL) = (${t.pinY} IS NULL)) AND ((${t.pinW} IS NULL) = (${t.pinH} IS NULL)) AND (${t.pinX} IS NULL OR (${t.pinX} BETWEEN 0 AND 1 AND ${t.pinY} BETWEEN 0 AND 1)) AND (${t.pinW} IS NULL OR (${t.pinW} > 0 AND ${t.pinH} > 0 AND ${t.pinX} + ${t.pinW} <= 1.000001 AND ${t.pinY} + ${t.pinH} <= 1.000001))`,
    ),
    settledChk: check(
      'mockup_comments_settled_chk',
      sql`(${t.settled} IS NULL AND num_nonnulls(${t.settledByMockupId}, ${t.settledNote}, ${t.settledAt}) = 0) OR (${t.settled} = 'answered' AND ${t.settledByMockupId} IS NOT NULL AND ${t.settledAt} IS NOT NULL) OR (${t.settled} = 'resolved' AND ${t.settledByMockupId} IS NOT NULL AND ${t.settledAt} IS NOT NULL AND ${t.settledNote} ~ '[^[:space:]]')`,
    ),
  }),
);
