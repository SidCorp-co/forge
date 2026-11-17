// The command a channel agent's owner types to watch its resident session live (ISS-946). The box
// runs that session as a Claude Code background session inside a sandbox of the room's own
// (ISS-1268 BR) and names, on its heartbeat (`capabilities.chatRooms`), each live room's project by
// the session it serves; core composes the command from that alone, and gives none for a session no
// room holds.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** `forge-runner chat attach <slug>` for `sessionId`, from a box's declared capabilities; null where no room of that box holds it. */
export function roomAttachOf(capabilities: unknown, sessionId: string): string | null {
  const declared = (capabilities ?? {}) as { chatRooms?: unknown };
  const rooms = declared.chatRooms as { sessions?: unknown } | undefined;
  if (!rooms) return null;
  const sessions = (rooms.sessions ?? {}) as Record<string, unknown>;
  const slug = sessions[sessionId];
  if (typeof slug !== 'string' || slug.length === 0) return null;
  return `forge-runner chat attach ${shellQuote(slug)}`;
}

/** The attach command for a session, read from the box it runs on. */
export async function roomAttachFor(row: {
  id: string;
  deviceId: string | null;
}): Promise<string | null> {
  if (!row.deviceId) return null;
  const [box] = await db
    .select({ capabilities: devices.capabilities })
    .from(devices)
    .where(eq(devices.id, row.deviceId))
    .limit(1);
  return roomAttachOf(box?.capabilities, row.id);
}
