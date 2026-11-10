// The turns of a room's session (ISS-1202), owned by the `support` domain beside its rooms and
// actions (`schema-support.ts`), kept apart only for size.

import { sql } from 'drizzle-orm';
import { check, index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agentSessions } from './schema-agent-sessions.js';

/**
 * One turn of a room's session (ISS-1202): opened when core hands the turn over, ended by the same
 * statement that moves the session off `running` (migration 0649's trigger). A room's session holds
 * one token across its turns, so the turn an act names is this row, never the token (ISS-1029).
 * A turn of the per-turn-token era keeps its old id, its token's, with that token's life as its span.
 */
export const supportSessionTurns = pgTable(
  'support_session_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => ({
    sessionStartedIdx: index('support_session_turns_session_started_idx').on(
      t.sessionId,
      t.startedAt,
    ),
    oneOpenUq: uniqueIndex('support_session_turns_one_open_uq')
      .on(t.sessionId)
      .where(sql`ended_at IS NULL`),
    spanChk: check(
      'support_session_turns_span_chk',
      sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`,
    ),
  }),
);
