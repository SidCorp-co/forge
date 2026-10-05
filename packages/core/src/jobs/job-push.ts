// The live push for a job's moves: one `job.changed` outbox event the WebSocket door turns into the
// room message, so every job writer pushes the same way and none imports the outbox itself.

import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { db } from '../db/client.js';
import { emitEvent } from '../outbox/index.js';

export async function pushJobChanged(change: OutboxEventPayload<'job.changed'>): Promise<void> {
  await emitEvent(db, 'job.changed', change);
}
