import { TOUR_EVENT_KINDS } from '@forge/contracts/tours';
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
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';

/**
 * What one person has seen of the product, one row per key: What's new's seen mark and each
 * tour's outcome. The key namespace is closed (`@forge/contracts/product-state:productStateKeyKind`),
 * and the CHECK holds the same two families.
 */
export const userProductState = pgTable(
  'user_product_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.key] }),
    check(
      'user_product_state_key_chk',
      sql`${t.key} = 'whats_new_seen_at' OR ${t.key} ~ '^tour:[a-z0-9]+(-[a-z0-9]+)*$' AND length(${t.key}) <= 69`,
    ),
  ],
);

/**
 * What happened on each tour run: it started, it was finished, it was closed at a step, or a step
 * was skipped because its anchor was not on the page. Insert-only; read to tell how far people get.
 */
export const productTourEvents = pgTable(
  'product_tour_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tourId: text('tour_id').notNull(),
    revision: integer('revision').notNull(),
    kind: text('kind', { enum: TOUR_EVENT_KINDS }).notNull(),
    step: integer('step'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('product_tour_events_tour_idx').on(t.tourId, t.revision, t.createdAt),
    check(
      'product_tour_events_kind_chk',
      sql`${t.kind} IN ('started', 'completed', 'dismissed', 'step_skipped')`,
    ),
    check(
      'product_tour_events_step_chk',
      sql`(${t.kind} IN ('dismissed', 'step_skipped')) = (${t.step} IS NOT NULL) AND (${t.step} IS NULL OR ${t.step} BETWEEN 1 AND 4)`,
    ),
  ],
);
