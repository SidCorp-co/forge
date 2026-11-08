// A message sent straight to a room's session, as `POST /api/agent-sessions/send` does (ISS-950). A
// room's session acts only under the token its room's turn hands it, so a turn sent as a web chat
// turn ran with none of the room's grants and said so in prose. The module that owns rooms hands in
// how such a turn runs; the kernel imports no chat application.

import type { agentSessions } from '../db/schema.js';

type SessionRow = typeof agentSessions.$inferSelect;

/** What the send door hands on: the session, who sent it, and what they sent. */
export interface RoomDirectTurn {
  session: SessionRow;
  senderId: string;
  message: string;
  attachmentIds: readonly string[];
  deviceId: string | null;
}

type Send = (turn: RoomDirectTurn) => Promise<void>;

let provided: { marker: string; send: Send } | null = null;

/** Registers how a direct message to a room's session runs, by the metadata key that marks one. */
export function provideRoomDirectTurn(marker: string, send: Send): void {
  provided = { marker, send };
}

/** How a direct message to this session runs, where it is a room's session; null for any other. */
export function roomDirectTurnOf(session: SessionRow): Send | null {
  if (!provided) return null;
  const marked = (session.metadata as Record<string, unknown> | null)?.[provided.marker];
  return marked ? provided.send : null;
}
