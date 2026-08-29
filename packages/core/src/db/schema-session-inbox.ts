// The durable inbox a core-side `session.send` writes to, one row per INTENT.
//
// Core does not sit on a socket waiting for a process to answer: it stamps an
// episode here, publishes, and decides later whether silence is an answer. The
// table is what makes that decision reconstructible after a restart, a device
// loss, or a redelivery of the same command.
//
// Split out of `schema.ts` only for size; it is a schema module like
// `schema-journal.ts` and is registered in `drizzle.config.ts` and the drizzle
// client's schema map alongside it.

import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agentSessions } from './schema.js';

// cm:why one row per INTENT, not per attempt, so a redelivery finds its own row and re-publishes the same seq rather than allocating a second one — the runner can then drop a key it has already applied, which is the only deduplication that survives a retry
export const sessionInboxKinds = ['work', 'answer', 'inject', 'checkpoint', 'cancel'] as const;
export type SessionInboxKind = (typeof sessionInboxKinds)[number];

// cm:guard `unknown` is a first-class outcome that MUST be resolved, never relabelled `gone`. Relabelling would only be sound if `gone` were idempotent with `delivered`, and it is not — `gone` mutates issue status and enqueues a job, so a message that was in fact consumed gets a second agent on top of it. A ChildStdin pipe is ~64 KiB: a CLI mid-turn that is not draining stdin makes the runner's write await past core's deadline, and the answer still lands when the pipe drains.
export const sessionSendOutcomes = ['delivered', 'gone', 'unknown'] as const;
export type SessionSendOutcome = (typeof sessionSendOutcomes)[number];

export const sessionInbox = pgTable(
  'session_inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentSessionId: uuid('agent_session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: sessionInboxKinds }).notNull(),
    intentId: text('intent_id').notNull(),
    body: text('body'),
    sendRequestedAt: timestamp('send_requested_at', { withTimezone: true }).notNull().defaultNow(),
    sendConfirmedAt: timestamp('send_confirmed_at', { withTimezone: true }),
    sendOutcome: text('send_outcome', { enum: sessionSendOutcomes }),
    // cm:guard THIS is the commit point, not `sendConfirmedAt` — a caller may only skip the durable cold path once this is set. The runner's ack proves the CLI parsed the line; it does not prove the model consumed it, because `queued_turn_count` is reported in the result payload, i.e. a queue that can still be non-empty when the process finishes and is then discarded at teardown. Treating the ack as acceptance converts this RFC's own failure mode from visible to invisible: the human's answer is gone and core has recorded success.
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    appliedTurn: integer('applied_turn'),
  },
  (t) => ({
    // cm:guard the idempotency key is (session, kind, intentId) and NEVER `seq`. A counter incremented per attempt cannot deduplicate — a redelivery of one intent gets a new number, and two intents racing a read-modify-write get the same one. The runner drops a KEY already applied, never a NUMBER already passed.
    intentUnique: uniqueIndex('session_inbox_intent_unique').on(
      t.agentSessionId,
      t.kind,
      t.intentId,
    ),
    seqUnique: uniqueIndex('session_inbox_seq_unique').on(t.agentSessionId, t.seq),
    unresolvedIdx: index('session_inbox_unresolved_idx')
      .on(t.sendRequestedAt)
      .where(sql`send_confirmed_at IS NULL OR (send_outcome = 'unknown' AND applied_at IS NULL)`),
  }),
);
