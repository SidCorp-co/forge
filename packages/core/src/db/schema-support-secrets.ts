// ISS-1348 (owner, 2026-11-19), owned by the `support` domain beside its rooms (`schema-support.ts`):
// a secret a room agent asked a person for, through the one secret door.

import { SECRET_SLOT_KINDS, SECRET_WRITE_VIAS } from '@forge/contracts/support';
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
import { projects } from './schema-projects.js';
import { supportRooms } from './schema-support.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * One ask a room agent made with `support.secret_link`: the slot it names (a variable at one
 * environment, a testing profile's credential, an integration's credential), the thread that asked,
 * and the link that opens that one field. `slot_key` names the slot as every write of it does, so a
 * value saved through any door finds the asks waiting on it and their threads hear that it was filled.
 *
 * Where the act asked for a pre-signed write, `write_hash` is the SHA-256 of its one-time token (the
 * token itself is never kept), good until `write_expires_at` and spent at `write_used_at`, with where
 * the write came from. Nothing here ever holds a value: a filled ask keeps its fingerprint alone.
 */
export const supportSecretAsks = pgTable(
  'support_secret_asks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id')
      .notNull()
      .references(() => supportRooms.id, { onDelete: 'cascade' }),
    thread: text('thread').notNull(),
    kind: text('kind', { enum: SECRET_SLOT_KINDS }).notNull(),
    slot: jsonb('slot').$type<Record<string, string | null>>().notNull(),
    slotKey: text('slot_key').notNull(),
    link: text('link').notNull(),
    writeHash: text('write_hash'),
    writeExpiresAt: timestamp('write_expires_at', { withTimezone: true }),
    writeUsedAt: timestamp('write_used_at', { withTimezone: true }),
    writeUsedFrom: text('write_used_from'),
    filledAt: timestamp('filled_at', { withTimezone: true }),
    filledFingerprint: text('filled_fingerprint'),
    filledVia: text('filled_via', { enum: SECRET_WRITE_VIAS }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    writeUq: uniqueIndex('support_secret_asks_write_uq')
      .on(t.writeHash)
      .where(sql`write_hash IS NOT NULL`),
    openIdx: index('support_secret_asks_open_idx')
      .on(t.slotKey, t.createdAt)
      .where(sql`filled_at IS NULL`),
    threadIdx: index('support_secret_asks_thread_idx').on(t.roomId, t.thread, t.createdAt),
    kindChk: check(
      'support_secret_asks_kind_chk',
      sql`${t.kind} IN (${inList(SECRET_SLOT_KINDS)})`,
    ),
    viaChk: check(
      'support_secret_asks_via_chk',
      sql`${t.filledVia} IS NULL OR ${t.filledVia} IN (${inList(SECRET_WRITE_VIAS)})`,
    ),
    writeChk: check(
      'support_secret_asks_write_chk',
      sql`(${t.writeHash} IS NULL) = (${t.writeExpiresAt} IS NULL)`,
    ),
  }),
);
