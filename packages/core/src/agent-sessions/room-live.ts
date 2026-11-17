/**
 * ISS-1268 — what the room's other readers are shown of an Agent turn in flight. The asker is sent
 * every live item (`broadcast.ts:broadcastLive`); every other reader of the room is sent the same
 * frame without the words: no text, no thinking and no suggested prompt, the draft no screen has
 * passed (REQ-32 criterion 6, as `assistant/conversation-progress.ts` gives a room its view). What
 * is left says the turn is working, retrying, compacting or held, and when it ended.
 *
 * Who reads the room is the conversations side's to answer, through the same check its delivery
 * takes, so the module that owns it hands the fan-out in at boot and the kernel imports none of it.
 */

import type {
  AgentSessionLiveFrame,
  AgentSessionLiveItem,
} from '@forge/contracts/agent-session-live';
import { logger } from '../lib/logger.js';

/** Publish one frame, unstored, to every reader of the room but the asker. */
type RoomTurnLive = (args: {
  conversationId: string;
  askerUserId: string | null;
  event: 'agent-session.live';
  frame: AgentSessionLiveFrame;
}) => Promise<void>;

let fanout: RoomTurnLive | null = null;

/** Registers the room's fan-out. Called once at boot by the module that owns the room's readers. */
export function provideRoomTurnLive(fn: RoomTurnLive): void {
  fanout = fn;
}

const WORDS: ReadonlySet<AgentSessionLiveItem['kind']> = new Set([
  'text',
  'thinking',
  'suggestion',
]);

/** The items a reader who did not ask is shown: everything but the words. */
export function roomViewOfLive(items: readonly AgentSessionLiveItem[]): AgentSessionLiveItem[] {
  return items.filter((item) => !WORDS.has(item.kind));
}

/** A room turn's live items, in the room's view, to its other readers; a text-only batch sends nothing. */
export function showRoomTurnLive(
  session: { id: string; projectId: string },
  conversationId: string,
  askerUserId: string | null,
  items: readonly AgentSessionLiveItem[],
): void {
  const room = roomViewOfLive(items);
  if (room.length === 0) return;
  if (!fanout) {
    logger.error(
      { sessionId: session.id, conversationId },
      'agent-sessions: no module registered the room fan-out; the room is not shown this turn',
    );
    return;
  }
  fanout({
    conversationId,
    askerUserId,
    event: 'agent-session.live',
    frame: { sessionId: session.id, projectId: session.projectId, conversationId, items: room },
  }).catch((err: unknown) =>
    logger.warn({ err, sessionId: session.id, conversationId }, 'room live frame: not published'),
  );
}
