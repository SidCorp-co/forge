import type { HooksBus } from '../pipeline/hooks.js';
import { projectRoom } from './rooms.js';
import { roomManager } from './server.js';

/**
 * Bridges the internal hooks bus onto the WebSocket room manager so browser
 * clients receive cache-invalidation events. Web's event router
 * (src/lib/ws/event-router.ts) reacts to these exact event names — do not
 * rename without updating both sides in lockstep.
 *
 * Scope: publish-only. Does not mutate domain data. Publish failures are
 * swallowed by the bus (see HooksBus.emit).
 */
export function registerWsBroadcastSubscribers(bus: HooksBus): void {
  bus.on('issueCreated', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'issue.created',
      data: {
        issueId: p.issueId,
        projectId: p.projectId,
        actorId: p.actor.id,
      },
    });
  });

  bus.on('issueUpdated', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'issue.updated',
      data: {
        issueId: p.issueId,
        projectId: p.projectId,
        fields: p.fields,
        actorId: p.actor.id,
      },
    });
  });

  // `issue.statusChanged` is already published inline in transition.ts to
  // keep the publish atomic with the UPDATE. Do not double-emit here.
}
