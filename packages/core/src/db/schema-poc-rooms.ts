import { ROOM_STATES } from '@forge/contracts/poc-room';
import type { PageSnapshot } from '@forge/contracts/preview';
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentSessions } from './schema-agent-sessions.js';
import { users } from './schema-auth.js';
import { previews } from './schema-previews.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** What a settle holds while it runs and after: the page it draws, where it merged, what it wrote. */
export interface RoomSettleRecord {
  into: string;
  askedBy: string;
  askedAt: string;
  alt: string;
  /** The page as the person saw it at settle (rrweb Meta + FullSnapshot), until the picture is drawn. */
  snapshot: PageSnapshot | null;
  /** When the box was asked to merge; absent or null until then. Its report settles or reopens the room. */
  mergeAskedAt?: string | null;
  mergeSha: string | null;
  requirement: string | null;
  revision: number | null;
  issueId: string | null;
  refusals: { code: string; detail: string }[];
}

// A POC room (REQ-44, 0485): an idea preview (`preview_id`, whose sketch session is `session_id`)
// that members join and chat in, keeping every ask with when its preview showed it and the commit
// that did, and the items a person settled. `state` is ROOM_MACHINE's, written only by the kernel
// transition (0485 guards it). `data` is where the preview's data comes from: the project's demo
// data, or its dev environment (BC-12).
export const pocRooms = pgTable(
  'poc_rooms',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    previewId: uuid('preview_id')
      .notNull()
      .references(() => previews.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    aboutKind: text('about_kind', { enum: ['requirement', 'feedback'] }).notNull(),
    aboutKey: text('about_key').notNull(),
    branch: text('branch').notNull(),
    state: text('state', { enum: ROOM_STATES }).notNull().default('open'),
    detail: text('detail'),
    data: text('data', { enum: ['demo', 'environment'] }).notNull(),
    settle: jsonb('settle').$type<RoomSettleRecord>(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    projectIdx: index('poc_rooms_project_idx').on(t.projectId, t.createdAt),
    sessionUq: uniqueIndex('poc_rooms_session_uq').on(t.sessionId),
    previewUq: uniqueIndex('poc_rooms_preview_uq').on(t.previewId),
    stateChk: check('poc_rooms_state_chk', sql`${t.state} IN (${inList(ROOM_STATES)})`),
    aboutChk: check(
      'poc_rooms_about_chk',
      sql`(${t.aboutKind} = 'requirement' AND ${t.aboutKey} ~ '^REQ-[0-9]{1,9}$') OR (${t.aboutKind} = 'feedback' AND ${t.aboutKey} ~ '^FB-[0-9]{1,9}$')`,
    ),
    dataChk: check('poc_rooms_data_chk', sql`${t.data} IN ('demo', 'environment')`),
    settleChk: check(
      'poc_rooms_settle_chk',
      sql`${t.state} = 'open' OR ${t.state} = 'abandoned' OR ${t.settle} IS NOT NULL`,
    ),
  }),
);
export type PocRoomRow = typeof pocRooms.$inferSelect;

export const pocRoomMembers = pgTable(
  'poc_room_members',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => pocRooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.roomId, t.userId] }) }),
);

export const pocRoomTurns = pgTable(
  'poc_room_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => pocRooms.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: ['ask', 'trim'] }).notNull(),
    askedBy: uuid('asked_by').references(() => users.id, { onDelete: 'set null' }),
    ask: text('ask').notNull(),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
    reply: text('reply'),
    shownAt: timestamp('shown_at', { withTimezone: true }),
    commitSha: text('commit_sha'),
    files: jsonb('files').$type<string[]>(),
  },
  (t) => ({
    seqUq: uniqueIndex('poc_room_turns_seq_uq').on(t.roomId, t.seq),
    kindChk: check('poc_room_turns_kind_chk', sql`${t.kind} IN ('ask', 'trim')`),
    commitChk: check(
      'poc_room_turns_commit_chk',
      sql`${t.commitSha} IS NULL OR ${t.commitSha} ~ '^[0-9a-f]{40}$'`,
    ),
  }),
);
export type PocRoomTurnRow = typeof pocRoomTurns.$inferSelect;

export const pocRoomItems = pgTable(
  'poc_room_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => pocRooms.id, { onDelete: 'cascade' }),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => pocRoomTurns.id, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    text: text('text').notNull(),
    settledBy: uuid('settled_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roomIdx: index('poc_room_items_room_idx').on(t.roomId, t.settledAt),
    commitChk: check('poc_room_items_commit_chk', sql`${t.commitSha} ~ '^[0-9a-f]{40}$'`),
  }),
);
export type PocRoomItemRow = typeof pocRoomItems.$inferSelect;
