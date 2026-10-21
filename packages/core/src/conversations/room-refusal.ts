import { HTTPException } from 'hono/http-exception';

type RoomRefusalStatus = 400 | 403 | 404 | 409;

/**
 * A refusal about a room, worded for the person reading it there: the sentence says "This room" and
 * names no id, the room's or any other; every id it is about rides `details` (ISS-1229 r27).
 */
export function roomRefusal(
  status: RoomRefusalStatus,
  code: string,
  sentence: string,
  details: Record<string, unknown>,
): HTTPException {
  return new HTTPException(status, { message: sentence, cause: { code, details } });
}
