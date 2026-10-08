import { SHARE_AUDIENCES, SHARE_SUBJECT_KINDS } from '@forge/contracts/shares';
import { sql } from 'drizzle-orm';
import {
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
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * One share link: a frozen, scrubbed report document a reader opens at `/s/<token>`, owned by the
 * `shares` domain. Only the SHA-256 of the token is kept; the token itself is shown once, at
 * creation. A share expires at `expires_at` (at most 30 days after creation) and stops at
 * `revoked_at`; nothing but the revocation and the view count ever changes.
 */
export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    audience: text('audience', { enum: SHARE_AUDIENCES }).notNull(),
    subjectKind: text('subject_kind', { enum: SHARE_SUBJECT_KINDS }).notNull(),
    snapshot: jsonb('snapshot').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    viewCount: integer('view_count').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
  },
  (t) => ({
    tokenHashUq: uniqueIndex('share_links_token_hash_uq').on(t.tokenHash),
    projectCreatedIdx: index('share_links_project_created_idx').on(t.projectId, t.createdAt),
    audienceChk: check(
      'share_links_audience_chk',
      sql`${t.audience} IN (${inList(SHARE_AUDIENCES)})`,
    ),
    subjectChk: check(
      'share_links_subject_kind_chk',
      sql`${t.subjectKind} IN (${inList(SHARE_SUBJECT_KINDS)})`,
    ),
    expiryChk: check(
      'share_links_expiry_chk',
      sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '30 days'`,
    ),
    snapshotChk: check('share_links_snapshot_chk', sql`jsonb_typeof(${t.snapshot}) = 'object'`),
    tokenHashChk: check('share_links_token_hash_chk', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  }),
);
