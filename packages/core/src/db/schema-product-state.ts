import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
