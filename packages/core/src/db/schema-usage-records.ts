import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { canonicalUuidText } from './column-checks.js';
import { projects } from './schema-projects.js';

export const usageSources = ['cli', 'api', 'desktop'] as const;

export type UsageSource = (typeof usageSources)[number];

export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source', { enum: usageSources }).notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
    estimatedCost: real('estimated_cost').notNull().default(0),
    requestCount: integer('request_count').notNull().default(1),
    sessionId: text('session_id'),
    projectName: text('project_name'),
    jobId: uuid('job_id'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectRecordedIdx: index('usage_records_project_recorded_idx').on(t.projectId, t.recordedAt),
    recordedAtIdx: index('usage_records_recorded_at_idx').on(t.recordedAt),
    sessionIdIdx: index('usage_records_session_id_idx').on(t.sessionId),
    sessionIdChk: check('usage_records_session_id_uuid_chk', canonicalUuidText(t.sessionId)),
    jobIdUq: uniqueIndex('usage_records_job_id_key').on(t.jobId).where(sql`job_id IS NOT NULL`),
  }),
);

export const usageRecordsRelations = relations(usageRecords, ({ one }) => ({
  project: one(projects, { fields: [usageRecords.projectId], references: [projects.id] }),
}));
