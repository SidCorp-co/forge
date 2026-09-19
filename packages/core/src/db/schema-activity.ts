import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
    actorAgency: text('actor_agency', { enum: actorAgencies }).notNull().default('human'),
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
  }),
);

export const activityLogRelations = relations(activityLog, ({ one }) => ({
  issue: one(issues, { fields: [activityLog.issueId], references: [issues.id] }),
}));
