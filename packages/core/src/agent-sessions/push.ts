// The live push for a session: one `session.pushed` outbox event the WebSocket door tells the
// project's room and the box's room, so no session writer publishes to a room itself.

import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import type { ProjectNowSource } from '@forge/contracts/project-now';
import type { WsFramePayloads } from '@forge/contracts/ws-frames';
import { db, type Tx } from '../db/client.js';
import { emitEvent } from '../outbox/index.js';

export async function pushSession(push: OutboxEventPayload<'session.pushed'>): Promise<void> {
  await emitEvent(db, 'session.pushed', push);
}

/** Tell a box to close the resident process it holds for a session, whose residency core ended. */
export async function closeResidentOnBox(sessionId: string, deviceId: string): Promise<void> {
  await pushSession({
    projectId: null,
    deviceId,
    userIds: [],
    event: 'agent:close',
    data: { sessionId, reason: 'residency_expired' },
  });
}

/**
 * Tell a project's open pages that what runs there now moved where no other frame says so: a run
 * declared, a master's pass opened or closed, a room's message recorded or its turn handed on or
 * ended (REQ-15 BC-10). Written in the caller's transaction, so a write that rolls back tells nobody.
 */
export async function pushProjectNow(
  exec: Tx,
  projectId: string,
  source: ProjectNowSource,
): Promise<void> {
  const data: WsFramePayloads['project.now.changed'] = { projectId, source };
  await emitEvent(exec, 'session.pushed', {
    projectId,
    deviceId: null,
    userIds: [],
    event: 'project.now.changed',
    data: { ...data },
  });
}
