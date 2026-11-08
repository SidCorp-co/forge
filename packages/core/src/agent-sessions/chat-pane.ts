// The command a channel agent's owner types to watch its resident session live (ISS-946). The box
// runs that session interactive in a tmux pane and names, on its heartbeat
// (`capabilities.chatPanes`), its tmux socket and each live pane by the session it serves; core
// composes the command from those alone, and gives none for a session no pane holds.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** `tmux -S <socket> attach -t <pane>` for `sessionId`, from a box's declared capabilities; null where no pane of that box holds it. */
export function paneAttachOf(capabilities: unknown, sessionId: string): string | null {
  const declared = (capabilities ?? {}) as { chatPanes?: unknown };
  const panes = declared.chatPanes as { socket?: unknown; sessions?: unknown } | undefined;
  if (!panes || typeof panes.socket !== 'string' || panes.socket.length === 0) return null;
  const sessions = (panes.sessions ?? {}) as Record<string, unknown>;
  const name = sessions[sessionId];
  if (typeof name !== 'string' || name.length === 0) return null;
  return `tmux -S ${shellQuote(panes.socket)} attach -t ${shellQuote(name)}`;
}

/** The attach command for a session, read from the box it runs on. */
export async function paneAttachFor(row: {
  id: string;
  deviceId: string | null;
}): Promise<string | null> {
  if (!row.deviceId) return null;
  const [box] = await db
    .select({ capabilities: devices.capabilities })
    .from(devices)
    .where(eq(devices.id, row.deviceId))
    .limit(1);
  return paneAttachOf(box?.capabilities, row.id);
}
