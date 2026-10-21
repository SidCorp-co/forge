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
