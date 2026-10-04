import { db } from '../db/client.js';
import { emitEvent } from '../outbox/index.js';

/** Tells every open view of a project that one of its integrations changed, so it refetches them. */
export async function announceIntegrationChanged(
  projectId: string,
  extra: { bindingId?: string; connectionId?: string } = {},
): Promise<void> {
  await emitEvent(db, 'integration.changed', { projectId, ...extra });
}
