// The decisions a requirement or one of its revisions can take more than once, each its own
// insert-only row: a return of a proposed revision, and a defer or undefer of the requirement.

import { DEFERRABLE_STATUSES, REQUIREMENT_DEFERRAL_ACTS } from '@forge/contracts/requirements';
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
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { requirementRevisions, requirements } from './schema-requirements.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// a return is a decision that can happen more than once on one revision (proposed, returned,
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

// a defer and an undefer are decisions a requirement can take more than once, so each is
// its own insert-only row (`requirement_deferral_guard()`, migration 0362); the head's status says
// `deferred`, and the latest defer row says from where, why and until when (ISS-85)
export const requirementDeferrals = pgTable(
  'requirement_deferrals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requirementId: uuid('requirement_id')
      .notNull()
      .references((): AnyPgColumn => requirements.id, { onDelete: 'cascade' }),
    act: text('act', { enum: REQUIREMENT_DEFERRAL_ACTS }).notNull(),
    fromStatus: text('from_status', {
      enum: [...DEFERRABLE_STATUSES, 'deferred'] as const,
    }).notNull(),
    targetPhase: text('target_phase'),
    reason: text('reason'),
    decidedBy: uuid('decided_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actChk: check(
      'requirement_deferrals_act_chk',
      sql`${t.act} IN (${inList(REQUIREMENT_DEFERRAL_ACTS)})`,
    ),
    fromChk: check(
      'requirement_deferrals_from_chk',
      sql`(${t.act} = 'defer' AND ${t.fromStatus} IN (${inList(DEFERRABLE_STATUSES)})) OR (${t.act} = 'undefer' AND ${t.fromStatus} = 'deferred')`,
    ),
    reasonChk: check(
      'requirement_deferrals_reason_chk',
      sql`${t.act} <> 'defer' OR ${t.reason} ~ '[^[:space:]]'`,
    ),
    phaseChk: check(
      'requirement_deferrals_phase_chk',
      sql`${t.act} = 'defer' OR ${t.targetPhase} IS NULL`,
    ),
    requirementIdx: index('requirement_deferrals_requirement_idx').on(t.requirementId, t.decidedAt),
  }),
);
