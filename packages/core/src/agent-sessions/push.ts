// The live push for a session: one `session.pushed` outbox event the WebSocket door tells the
// project's room and the box's room, so no session writer publishes to a room itself.

import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { db } from '../db/client.js';
import { emitEvent } from '../outbox/index.js';

export async function pushSession(push: OutboxEventPayload<'session.pushed'>): Promise<void> {
  await emitEvent(db, 'session.pushed', push);
}
