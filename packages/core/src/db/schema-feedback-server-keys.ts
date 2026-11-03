import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';

/**
 * A product server's key to file Feedback into its one project (ISS-922): minted by a holder of
 * `project.admin`, shown once, kept as the SHA-256 of its secret. It admits `POST
 * /api/projects/:id/feedback` on its project and nothing else (`feedback/server-key-door.ts`). Every
 * filing names the product's own agent account as its reporter (`account_id`, shared by every key of
 * one product in the project, a member of nothing), so a key is never a person's session.
 */
export const feedbackServerKeys = pgTable(
  'feedback_server_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The product the key speaks for, a short label such as `epod`. */
    product: text('product').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    /** The secret's first characters, shown in the listing so a holder can tell keys apart. */
    prefix: text('prefix').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    tokenHashUq: uniqueIndex('feedback_server_keys_token_hash_uq').on(t.tokenHash),
    projectIdx: index('feedback_server_keys_project_idx').on(t.projectId, t.createdAt),
    accountIdx: index('feedback_server_keys_account_idx').on(t.accountId),
    productChk: check(
      'feedback_server_keys_product_chk',
      sql`${t.product} ~ '[^[:space:]]' AND char_length(${t.product}) <= 64`,
    ),
    tokenHashChk: check(
      'feedback_server_keys_token_hash_chk',
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
