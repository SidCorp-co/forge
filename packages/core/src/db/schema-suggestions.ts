import {
  SUGGESTION_KINDS,
  SUGGESTION_PRODUCERS,
  SUGGESTION_STATUSES,
} from '@forge/contracts/suggestions';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { issues, projects, users } from './schema.js';
import { conversationMessages } from './schema-conversations.js';
import { feedback } from './schema-feedback.js';
import { requirements } from './schema-requirements.js';

export {
  SUGGESTION_KINDS,
  SUGGESTION_PRODUCERS,
  SUGGESTION_STATUSES,
  type SuggestionKind,
  type SuggestionProducer,
  type SuggestionStatus,
} from '@forge/contracts/suggestions';

// cm:why the assistant only proposes (workflow suggestion-lifecycle): a row against a base revision
// waits on a person; its effect is written by the accept and points back here, nothing is copied on
export const suggestions = pgTable(
  'suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: SUGGESTION_KINDS }).notNull(),
    // cm:why an exclusive arc of real foreign keys, never a target_type/target_id pair
    requirementId: uuid('requirement_id').references((): AnyPgColumn => requirements.id, {
      onDelete: 'cascade',
    }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    feedbackId: uuid('feedback_id').references((): AnyPgColumn => feedback.id, {
      onDelete: 'cascade',
    }),
    baseRevision: integer('base_revision'),
    payload: jsonb('payload'),
    payloadVersion: integer('payload_version').notNull().default(1),
    fingerprint: text('fingerprint').notNull(),
    status: text('status', { enum: SUGGESTION_STATUSES }).notNull().default('proposed'),
    producerKind: text('producer_kind', { enum: SUGGESTION_PRODUCERS }).notNull(),
    producerId: uuid('producer_id').references(() => users.id, { onDelete: 'set null' }),
    conversationMessageId: uuid('conversation_message_id').references(
      () => conversationMessages.id,
      { onDelete: 'set null' },
    ),
    model: text('model'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    payloadPurgedAt: timestamp('payload_purged_at', { withTimezone: true }),
  },
  (t) => ({
    arcChk: check(
      'suggestions_arc_chk',
      sql`num_nonnulls(${t.requirementId}, ${t.issueId}, ${t.feedbackId}) = 1`,
    ),
    kindChk: check(
      'suggestions_kind_chk',
      sql`${t.kind} IN (${sql.raw(SUGGESTION_KINDS.map((k) => `'${k}'`).join(', '))})`,
    ),
    statusChk: check(
      'suggestions_status_chk',
      sql`${t.status} IN ('proposed', 'accepted', 'rejected', 'stale', 'withdrawn')`,
    ),
    producerChk: check(
      'suggestions_producer_chk',
      sql`${t.producerKind} IN ('ba_assistant', 'agent', 'person')`,
    ),
    decidedChk: check(
      'suggestions_decided_chk',
      sql`(${t.status} = 'proposed') = (${t.decidedAt} IS NULL)`,
    ),
    rejectedChk: check(
      'suggestions_rejected_chk',
      sql`${t.status} <> 'rejected' OR (${t.reason} ~ '[^[:space:]]' AND ${t.decidedBy} IS NOT NULL)`,
    ),
    payloadChk: check(
      'suggestions_payload_chk',
      sql`${t.payload} IS NOT NULL OR (${t.payloadPurgedAt} IS NOT NULL AND ${t.status} IN ('rejected', 'stale', 'withdrawn'))`,
    ),
    // cm:why one open row per target, kind and fingerprint (SUGGESTION_DUPLICATE), so a retry or a
    // second turn saying the same thing does not queue a twin
    openTwinUq: uniqueIndex('suggestions_open_twin_uq')
      .on(t.kind, sql`coalesce(${t.requirementId}, ${t.issueId}, ${t.feedbackId})`, t.fingerprint)
      .where(sql`status = 'proposed'`),
    requirementIdx: index('suggestions_requirement_idx')
      .on(t.requirementId, t.status)
      .where(sql`requirement_id IS NOT NULL`),
    issueIdx: index('suggestions_issue_idx')
      .on(t.issueId, t.status)
      .where(sql`issue_id IS NOT NULL`),
    feedbackIdx: index('suggestions_feedback_idx')
      .on(t.feedbackId, t.status)
      .where(sql`feedback_id IS NOT NULL`),
    sweepIdx: index('suggestions_status_created_idx').on(t.status, t.createdAt),
  }),
);
