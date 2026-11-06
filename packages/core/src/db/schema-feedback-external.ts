import { FEEDBACK_EXTERNAL_CHANNELS } from '@forge/contracts/widget';
import { sql } from 'drizzle-orm';
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
import { feedback } from './schema-feedback.js';
import { integrationBindings } from './schema-project-config.js';
import { projects } from './schema-projects.js';

/**
 * Who filed an item from outside Forge (`feedback.reported_by` is then the channel's own account):
 * the visitor as they identified themselves, the binding they came through, the page they were on,
 * and, for a widget visitor only, the SHA-256 of their private status link (the token is shown
 * once); a support group member is handed none, since anyone in the group could open it and the
 * thread is its status. The email, the name, the signed id and the page are reporter data, cleared
 * with the rest of it on a redaction.
 */
export const feedbackExternalReporters = pgTable(
  'feedback_external_reporters',
  {
    feedbackId: uuid('feedback_id')
      .primaryKey()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: FEEDBACK_EXTERNAL_CHANNELS }).notNull(),
    bindingId: uuid('binding_id').references(() => integrationBindings.id, {
      onDelete: 'set null',
    }),
    visitorId: uuid('visitor_id').notNull(),
    email: text('email'),
    name: text('name'),
    signedUserId: text('signed_user_id'),
    pageContext: jsonb('page_context'),
    statusTokenHash: text('status_token_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusTokenUq: uniqueIndex('feedback_external_reporters_status_token_uq').on(t.statusTokenHash),
    projectIdx: index('feedback_external_reporters_project_idx').on(t.projectId),
    channelChk: check(
      'feedback_external_reporters_channel_chk',
      sql`${t.channel} IN (${sql.raw(FEEDBACK_EXTERNAL_CHANNELS.map((c) => `'${c}'`).join(', '))})`,
    ),
    statusTokenChk: check(
      'feedback_external_reporters_status_token_chk',
      sql`${t.statusTokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    statusLinkChk: check(
      'feedback_external_reporters_status_link_chk',
      sql`(${t.channel} = 'widget') = (${t.statusTokenHash} IS NOT NULL)`,
    ),
    pageContextChk: check(
      'feedback_external_reporters_page_context_chk',
      sql`${t.pageContext} IS NULL OR jsonb_typeof(${t.pageContext}) = 'object'`,
    ),
  }),
);
