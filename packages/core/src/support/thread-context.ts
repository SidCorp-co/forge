// What a thread holds around one member's message (ISS-1250, owner 2026-11-16): the thread's last
// lines before it, what its writer said there earlier, and the asks still open in it. The owner's
// ruling on what the epod master's post had just raised (16/11 02:18, then 02:21) was read as one
// about the agent's own settings: a warm session never sees a master's or Forge's post in its thread
// unless it reads the thread. Read on the agent's call (`asker`), never pushed into a turn; built
// from the thread's stored conversation and the room's master asks, so nothing new is kept.

import { and, eq, isNull } from 'drizzle-orm';
import { readMessages, type StoredConversationMessage } from '../conversations/index.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema-projects.js';
import { supportMasterAsks } from '../db/schema-support-asks.js';

/** How many of the thread's lines before the message are handed. */
const RECENT_LINES = 6;
/** How many of the writer's own earlier lines, before those, are handed. */
const EARLIER_LINES = 5;
/** How far back the thread is read. */
const LINES_READ = 60;

export type ThreadLine = Pick<
  StoredConversationMessage,
  'role' | 'content' | 'authorLabel' | 'authorKey' | 'externalId'
>;

/** One line as the agent reads it: who said it (`bot` for any bot's post there) and what. */
export interface SaidLine {
  from: string;
  text: string;
}

export interface ThreadAround {
  /** The thread's last lines before the message, oldest first. */
  recent: SaidLine[];
  /** What the writer said earlier in the thread, before those, oldest first: their asks and rulings. */
  theirEarlier: SaidLine[];
}

const saidOf = (m: ThreadLine): SaidLine => ({
  from: m.role === 'user' ? (m.authorLabel ?? 'member') : 'bot',
  text: m.content,
});

/** The lines around `message` by `writer` (their chat account id), out of the thread's lines. */
export function aroundMessage(
  lines: readonly ThreadLine[],
  message: string,
  writer: string,
): ThreadAround {
  const at = lines.findIndex((m) => m.externalId === message);
  const before = (at < 0 ? lines : lines.slice(0, at)).filter(
    (m) => m.role !== 'system' && m.content.trim().length > 0,
  );
  return {
    recent: before.slice(-RECENT_LINES).map(saidOf),
    theirEarlier: before
      .slice(0, -RECENT_LINES)
      .filter((m) => m.role === 'user' && m.authorKey === writer)
      .slice(-EARLIER_LINES)
      .map(saidOf),
  };
}

/** The thread's lines, as far back as it is read. */
export const threadLines = (conversationId: string) => readMessages(conversationId, LINES_READ);

/** The asks a session put to a master in this thread that no master has answered yet. */
export async function openAsksOf(roomId: string, thread: string): Promise<string[]> {
  const rows = await db
    .select({ slug: projects.slug, question: supportMasterAsks.question })
    .from(supportMasterAsks)
    .innerJoin(projects, eq(projects.id, supportMasterAsks.projectId))
    .where(
      and(
        eq(supportMasterAsks.roomId, roomId),
        eq(supportMasterAsks.thread, thread),
        isNull(supportMasterAsks.answeredAt),
      ),
    );
  return rows.map((r) => `to the ${r.slug} master: ${r.question}`);
}
