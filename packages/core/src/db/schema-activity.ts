import { RECORD_ACTIONS } from '@forge/contracts/record-events';
import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { issues } from './schema.js';

export const actorTypes = ['user', 'device'] as const;
export type ActorType = (typeof actorTypes)[number];

export const actorAgencies = ['human', 'agent'] as const;

export const activityLog = pgTable(
  'activity_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    actorType: text('actor_type', { enum: actorTypes }).notNull(),
    actorId: uuid('actor_id').notNull(),
    actorAgency: text('actor_agency', { enum: actorAgencies }).notNull(),
    action: text('action').notNull(),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * ISS-849 — redelivery-dedup key (e.g. `transition:<outboxId>`). Nullable:
     * most rows have no natural redelivery source. Distinct from notifications'
     * resolutionKey, which is a per-issue auto-resolve mechanism, not a
     * per-delivery identity.
     */
    dedupeKey: text('dedupe_key'),
  },
  (t) => ({
    issueCreatedIdx: index('activity_log_issue_created_idx').on(t.issueId, t.createdAt),
    dedupeKeyIdx: index('activity_log_dedupe_key_idx').on(t.dedupeKey),
    createdAtIdx: index('activity_log_created_at_idx').on(t.createdAt),
    /**
     * ISS-56 — a record event (`record.<kind>`) carries one of the closed kinds, whatever door
     * wrote it. Every other action is untouched by this check.
     */
    recordKindChk: check(
      'activity_log_record_kind_chk',
      sql`${t.action} NOT LIKE 'record.%' OR ${t.action} IN (${sql.raw(
        RECORD_ACTIONS.map((a) => `'${a}'`).join(', '),
      )})`,
    ),
    /** The readers that replaced comment parsing walk one issue's records of a kind, in order. */
    recordIssueIdx: index('activity_log_record_issue_idx')
      .on(t.issueId, t.action, t.createdAt)
      .where(sql`${t.action} LIKE 'record.%'`),
    /** One event per mirrored comment, so a redelivered or edited comment cannot fork the record. */
    recordCommentUq: uniqueIndex('activity_log_record_comment_uq')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} LIKE 'record-comment:%'`),
  }),
);

export const activityLogRelations = relations(activityLog, ({ one }) => ({
  issue: one(issues, { fields: [activityLog.issueId], references: [issues.id] }),
}));
