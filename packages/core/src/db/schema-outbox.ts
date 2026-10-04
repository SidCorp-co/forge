import { OUTBOX_DELIVERY_STATUSES } from '@forge/contracts/outbox-consumers';
import { OUTBOX_EVENT_TYPES } from '@forge/contracts/outbox-events';
import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { issues, projects } from './schema.js';

const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v}'`).join(', '));

// The one durable outbox (pattern v2 BC-18): one row per event, written in the transaction of the
// act it reports (`outbox/emit.ts:emitEvents`). `seq` orders an issue's events for each consumer.
export const pipelineOutbox = pgTable(
  'pipeline_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).notNull().generatedByDefaultAsIdentity(),
    type: text('type', { enum: OUTBOX_EVENT_TYPES }).notNull(),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    typeChk: check('pipeline_outbox_type_chk', sql`${t.type} IN (${inList(OUTBOX_EVENT_TYPES)})`),
    createdIdx: index('pipeline_outbox_created_idx').on(t.createdAt),
  }),
);

// One row per (event, consumer), written with the event. It is the consumer's delivery state and its
// inbox: a consumer that writes rows marks it `delivered` in the same transaction
// (`outbox/consumers.ts:Delivery.inbox`). `issue_id` and `seq` repeat the event's, so the claim can
// hold back an issue's later deliveries while an earlier one to the same consumer is pending.
export const outboxDeliveries = pgTable(
  'outbox_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => pipelineOutbox.id, { onDelete: 'cascade' }),
    consumer: text('consumer').notNull(),
    issueId: uuid('issue_id'),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    status: text('status', { enum: OUTBOX_DELIVERY_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    leaseToken: uuid('lease_token'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deadAt: timestamp('dead_at', { withTimezone: true }),
  },
  (t) => ({
    statusChk: check(
      'outbox_deliveries_status_chk',
      sql`${t.status} IN (${inList(OUTBOX_DELIVERY_STATUSES)})`,
    ),
    eventConsumerUq: uniqueIndex('outbox_deliveries_event_consumer_uq').on(t.eventId, t.consumer),
    dueIdx: index('outbox_deliveries_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    issueOrderIdx: index('outbox_deliveries_issue_order_idx')
      .on(t.consumer, t.issueId, t.seq)
      .where(sql`${t.status} = 'pending' AND ${t.issueId} IS NOT NULL`),
    deadIdx: index('outbox_deliveries_dead_idx')
      .on(t.deadAt)
      .where(sql`${t.status} = 'dead'`),
    deliveredIdx: index('outbox_deliveries_delivered_idx')
      .on(t.deliveredAt)
      .where(sql`${t.status} = 'delivered'`),
  }),
);
