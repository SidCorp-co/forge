// The live push for a device: one `device.pushed` outbox event the WebSocket door tells the owner's
// room and the box's room, so no device writer publishes to a room itself.

import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { db, type Tx } from '../db/client.js';
import { emitEvent } from '../outbox/index.js';

export async function pushDevice(
  push: OutboxEventPayload<'device.pushed'>,
  executor: Tx = db,
): Promise<void> {
  await emitEvent(executor, 'device.pushed', push);
}
