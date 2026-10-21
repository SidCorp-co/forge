import { HTTPException } from 'hono/http-exception';

type RoomRefusalStatus = 400 | 403 | 404 | 409;

/** A room refusal says "This room" and names no id; the ids ride `details` (ISS-1229 r27). */
export function roomRefusal(
  status: RoomRefusalStatus,
  code: string,
  sentence: string,
  details: Record<string, unknown>,
): HTTPException {
  return new HTTPException(status, { message: sentence, cause: { code, details } });
}

export function roomGone(conversationId: string): HTTPException {
  return roomRefusal(404, 'CONVERSATION_GONE', 'This room no longer exists.', { conversationId });
}

/**
 * A refusal raised while a room was being made, with that room's id taken out of its details: the
 * transaction that made it rolled back, so the id names a room that never existed (ISS-1229 r30).
 */
export function withoutUnsavedRoom(err: unknown, roomId: string | null): unknown {
  if (!roomId || !(err instanceof HTTPException)) return err;
  const cause = err.cause as { code?: unknown; details?: Record<string, unknown> } | undefined;
  if (!cause?.details || cause.details.conversationId !== roomId) return err;
  const { conversationId: _unsaved, ...details } = cause.details;
  return new HTTPException(err.status, { message: err.message, cause: { ...cause, details } });
}
