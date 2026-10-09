// When a POC room's agent ends a turn (REQ-44 BC-4, BC-6, BC-12): its sketch session's terminal bridge
// (`agent-sessions/terminal-effects.ts`, marker `pocRoom`) lands here. Every ask still waiting is
// stamped shown at that moment, the agent's reply is kept, and the box commits the sketch and reports
// the head: the commit that showed those asks. A change that touches the schema while the preview talks
// to the project's dev environment stops the preview by name. A settle waiting on the agent's trim
// goes on from here.

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { provideTerminalSessionBridge, readTranscript } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import type { agentSessions } from '../db/schema.js';
import { pocRoomTurns } from '../db/schema-poc-rooms.js';
import { logger } from '../lib/logger.js';
import { readProjectDocument } from '../project-config/index.js';
import { rowOf } from './access.js';
import { askSnapshot } from './approve.js';
import { runSettle } from './room-settle.js';
import { inRoomOrder, roomOfSession, roomRow } from './rooms.js';
import { schemaFilesOf } from './rules.js';
import { failPreview } from './service.js';

type SessionRow = typeof agentSessions.$inferSelect;

const REPLY_MAX = 4000;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n');
}

/** The agent's last words in the turn that ended: its last assistant entry with text. */
export function lastReply(entries: readonly Record<string, unknown>[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: unknown; role?: unknown; content?: unknown };
    if (entry.type === 'user' || entry.role === 'user') return null;
    if (entry.type !== 'assistant' && entry.role !== 'assistant') continue;
    const text = textOf(entry.content).trim();
    if (text) return text.slice(0, REPLY_MAX);
  }
  return null;
}

/** The bridge's delivery: a room's turn ended. */
export async function deliverRoomTurnEnd(session: SessionRow): Promise<void> {
  const room = await roomOfSession(session.id);
  if (!room) {
    logger.error(
      { sessionId: session.id },
      'poc-rooms: a session marked as a room agent belongs to no room; its turn end is not shown',
    );
    return;
  }
  const shownAt = new Date();
  await inRoomOrder(room.id, async () => {
    const pending = await db
      .select()
      .from(pocRoomTurns)
      .where(and(eq(pocRoomTurns.roomId, room.id), isNull(pocRoomTurns.shownAt)))
      .orderBy(asc(pocRoomTurns.seq));
    if (pending.length === 0) return;
    const ids = pending.map((t) => t.id);
    await db.update(pocRoomTurns).set({ shownAt }).where(inArray(pocRoomTurns.id, ids));
    const last = pending[pending.length - 1];
    const reply = lastReply(await readTranscript(session.id));
    if (last && reply) {
      await db.update(pocRoomTurns).set({ reply }).where(eq(pocRoomTurns.id, last.id));
    }
    await readCommit(room.id, ids);
    const now = await roomRow(room.id);
    if (now.state === 'settling' && pending.some((t) => t.kind === 'trim')) {
      await runSettle(now.id);
    }
  });
}

/** The commit that showed these turns: the box commits the sketch and reports its head. */
async function readCommit(roomId: string, turnIds: string[]): Promise<void> {
  const room = await roomRow(roomId);
  const preview = await rowOf(room.previewId);
  if (preview.state !== 'live') return;
  let taken: Awaited<ReturnType<typeof askSnapshot>>;
  try {
    taken = await askSnapshot(preview, true);
  } catch (err) {
    logger.warn(
      { err, roomId, previewId: preview.id },
      'poc-rooms: the box read no commit for a turn; its asks show without one',
    );
    return;
  }
  if (!taken.head) return;
  await db
    .update(pocRoomTurns)
    .set({ commitSha: taken.head, files: taken.files })
    .where(inArray(pocRoomTurns.id, turnIds));
  if (room.data === 'demo') return;
  const extra = (await readProjectDocument(room.projectId))?.document.fastLane?.migrations ?? [];
  const schema = schemaFilesOf(taken.files, extra);
  if (schema.length === 0) return;
  await failPreview(
    await rowOf(room.previewId),
    'SCHEMA_NEEDS_THROWAWAY_DATA',
    `the room's branch changes the schema (${schema.slice(0, 10).join(', ')}) and its preview talks to the project's dev environment, which a POC never migrates: declare demo data (preview.demo) so a room runs on throwaway data, then open the room again`,
  );
}

/** Hands the room's turn-end delivery to the session bridge; called once at boot. */
export function registerRoomBridge(): void {
  provideTerminalSessionBridge('pocRoom', deliverRoomTurnEnd);
}
