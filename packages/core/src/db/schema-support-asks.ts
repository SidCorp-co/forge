// ISS-1243 (owner, 2026-11-15), owned by the `support` domain beside its rooms (`schema-support.ts`),
// kept apart only for size: a chat sender's temporary account, and a room agent's ask of a master.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentSessions } from './schema-agent-sessions.js';
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';
import { supportRooms } from './schema-support.js';
import { conversationAdapters } from './schema-vocabulary.js';

/**
 * The temporary account of a chat sender who holds no Forge account (item 10): one per chat identity,
 * made on its first message, so who wrote and what they wrote before resolve for everyone. It is no
 * `users` row: it holds no email, password, token, OAuth account, membership or grant, so it can never
 * sign in and nothing can act as it. Linked later (`linkedUserId`), its history stays keyed on the same
 * chat identity and reads as that user's.
 */
export const chatTemporaryAccounts = pgTable(
  'chat_temporary_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source', { enum: conversationAdapters }).notNull(),
    externalNamespace: text('external_namespace').notNull(),
    externalId: text('external_id').notNull(),
    externalLabel: text('external_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The Forge account it was linked to, once a link or a naming confirmed one. */
    linkedUserId: uuid('linked_user_id').references(() => users.id, { onDelete: 'set null' }),
    linkedAt: timestamp('linked_at', { withTimezone: true }),
  },
  (t) => ({
    identityUq: uniqueIndex('chat_temporary_accounts_identity_uq').on(
      t.source,
      t.externalNamespace,
      t.externalId,
    ),
    linkedChk: check(
      'chat_temporary_accounts_linked_chk',
      sql`${t.linkedUserId} IS NULL OR ${t.linkedAt} IS NOT NULL`,
    ),
  }),
);

/**
 * A room agent's question to a master, asked in its turn (items 14, 21): the master of its own project
 * or of a project it follows. The answer is handed back into the same room session's thread; the wait
 * from `askedAt` to `answeredAt` is what a breach is read from.
 */
export const supportMasterAsks = pgTable(
  'support_master_asks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => supportRooms.id, { onDelete: 'cascade' }),
    thread: text('thread').notNull(),
    /** The project whose master is asked: the room's home, or a project it follows. */
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
    turnId: uuid('turn_id'),
    question: text('question').notNull(),
    /** The agent declared a new need of the person begins with this ask: the case's rounds count from it (ISS-1483). */
    opensCase: boolean('opens_case').notNull().default(false),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
    answer: text('answer'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    answeredBy: uuid('answered_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    openIdx: index('support_master_asks_open_idx')
      .on(t.projectId, t.askedAt)
      .where(sql`answered_at IS NULL`),
    threadIdx: index('support_master_asks_thread_idx').on(t.roomId, t.thread),
    answeredChk: check(
      'support_master_asks_answered_chk',
      sql`(${t.answer} IS NULL) = (${t.answeredAt} IS NULL)`,
    ),
  }),
);
