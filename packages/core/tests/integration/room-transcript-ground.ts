/**
 * ISS-1090 — the ground the two transcript-index suites stand on: a room, some
 * things said in it, and a window that closed on something other than an answer.
 *
 * Shared rather than copied because the two halves ask different questions of
 * the same fixtures — who may read a room, and what the index holds — and a
 * second copy of `closeSilentWindow` would be a second definition of what a
 * silence is.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TestDatabase } from '../helpers/index.js';

type Store = typeof import('../../src/conversations/store.js');

/** A room the adapter opened, with the project's handle already in it. */
export async function openRoom(
  store: Store,
  projectId: string,
  shape: 'group' | 'direct' = 'group',
) {
  return store.openConversation({
    adapter: 'rocketchat',
    externalId: `chat.example.co ${randomUUID()}`,
    shape,
    projectId,
  });
}

export interface SpokenLine {
  text: string;
  who?: string;
  /** Absent leaves the column alone; `null` says the transport named no id. */
  externalId?: string | null;
}

/** Say these, in order, as one commit — which is how the collector writes a turn. */
export async function say(
  store: Store,
  conversationId: string,
  lines: readonly SpokenLine[],
): Promise<unknown> {
  return store.appendMessages({
    conversationId,
    messages: lines.map((l) => ({
      role: 'user' as const,
      content: l.text,
      authorLabel: l.who ?? 'ana',
      ...(l.externalId === undefined ? {} : { externalId: l.externalId }),
    })),
  });
}

/**
 * A window that closed on something other than an answer.
 */
// cm:guard written as a ROW rather than through the router, because what the suites need is the
// state a silence leaves behind and not the path that reaches it: the index must be indifferent to
// this row's existence, and driving the router would prove the router instead (ISS-1090 rule 2).
export async function closeSilentWindow(
  harness: TestDatabase,
  args: {
    conversationId: string;
    projectId: string;
    firstSeq: number;
    lastSeq: number;
    decision?: string;
  },
): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO conversation_windows
      (conversation_id, project_id, adapter, first_seq, last_seq, claimed_at, closed_at, decision)
    VALUES (${args.conversationId}::uuid, ${args.projectId}::uuid, 'rocketchat',
            ${args.firstSeq}, ${args.lastSeq}, now(), now(), ${args.decision ?? 'guard-dormant'})
  `);
}

/** The passage rows of one room, in the order the rule wrote them. */
export async function passageRows(
  harness: TestDatabase,
  conversationId: string,
): Promise<unknown[]> {
  const rows = await harness.db.execute(sql`
    SELECT first_seq, first_offset, last_seq, last_offset, message_count, is_open, text
    FROM conversation_passages WHERE conversation_id = ${conversationId}::uuid
    ORDER BY first_seq, first_offset
  `);
  return Array.isArray(rows) ? rows : ((rows as { rows: unknown[] }).rows ?? []);
}
