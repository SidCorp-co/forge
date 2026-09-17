// ISS-1030 — the raw carrier a chat session's transcript is derived from.
//
// Split out of `schema.ts` only for size; it is a schema module like
// `schema-session-inbox.ts` and is registered in `drizzle.config.ts` and the
// drizzle client's schema map alongside it.

import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentSessions } from './schema.js';

// `job_events` is the pipeline path's carrier and cannot be this one:
// `transport/agent_sessions.rs` states that chat never touches the `jobs`
// table, so a chat turn has no job row to hang events off. This is the same
// shape for the same fold — `jobs/session-transcript.ts` reads both through one
// reader — so a chat turn's transcript is derived by the parser every other
// producer already goes through instead of being built in Rust.
//
// cm:guard `seq` is assigned by the WRITER, not by this server, and that is what
// carries a row's identity. The runner's `transport/events.rs` retries an
// identical batch on every 5xx and every transport error with nothing on it to
// tell a retry from a fresh post, so a server-assigned `seq` would store a
// committed-but-unacknowledged batch twice. With the identity in the unique
// index below the retry is a no-op. Moving assignment back to the server
// re-admits the duplicate in silence.
// cm:edge lockstep -> packages/core/src/jobs/session-transcript.ts — the reader
// there folds and checkpoints a CONTIGUOUS prefix because of that decision: a
// writer-assigned `seq` makes a late lower one possible, and a `> lastSeq`
// cursor would skip it for ever.
export const agentSessionEventKinds = [
  'stdout',
  // cm:why core's own rows, and the reason they exist: the Claude stream carries
  // no user prompt that the fold can act on — `parseStreamMessages` answers
  // `{messages:[]}` for a `user` line whose content holds no `tool_result` — so a
  // transcript rebuilt from `stdout` alone would lose every turn the person
  // typed. `agent-sessions/chat-turn.ts` writes one of these per user turn and
  // the reader appends its `data.entry` verbatim, which is what makes a full
  // re-derive of a chat session equal to the incremental one.
  'seed',
] as const;
export type AgentSessionEventKind = (typeof agentSessionEventKinds)[number];

export const agentSessionEvents = pgTable(
  'agent_session_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentSessionId: uuid('agent_session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind', { enum: agentSessionEventKinds }).notNull(),
    data: jsonb('data').notNull().default({}),
    seq: integer('seq').notNull(),
  },
  (t) => ({
    // cm:guard the identity the writer assigns, and the reason `ON CONFLICT DO
    // NOTHING` makes a retried batch a no-op rather than a second copy.
    sessionSeqIdx: uniqueIndex('agent_session_events_session_id_seq_idx').on(
      t.agentSessionId,
      t.seq,
    ),
    // cm:guard `(agent_session_id, seq)` above cannot answer `max(ts)` for one
    // session — it orders by `seq` — so the retention sweep would read a
    // session's whole history to age it. ISS-1013 measured the same thing on
    // `job_events`; this is that index for this table.
    sessionTsIdx: index('agent_session_events_session_id_ts_idx').on(t.agentSessionId, t.ts),
  }),
);

export const agentSessionEventsRelations = relations(agentSessionEvents, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentSessionEvents.agentSessionId],
    references: [agentSessions.id],
  }),
}));
