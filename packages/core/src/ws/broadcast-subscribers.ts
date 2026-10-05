import type { ConsumedBy, OutboxConsumerOf } from '@forge/contracts/outbox-consumers';
import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { deviceRoom, projectRoom, roomManager, userRoom } from '../lib/rooms.js';
import { consume } from '../outbox/index.js';

const pub = (room: string, event: string, data: unknown) =>
  roomManager.publish(room, { event, data });

/**
 * The WebSocket push, a consumer of the outbox: each event becomes the cache-invalidation message
 * web's event router (web-v2 `src/lib/ws/event-router.ts`) reacts to, under the same names on both
 * sides. Publish-only; it writes no data.
 */
function on<T extends ConsumedBy<'ws-broadcast'>>(
  type: T,
  publish: (p: OutboxEventPayload<T>) => void,
): void {
  consume(type, { name: 'ws-broadcast' as OutboxConsumerOf<T>, handle: publish });
}

export function registerWsBroadcastSubscribers(): void {
  // every open view of either side refetches the edge
  on('issue.dependency.changed', (p) => {
    pub(projectRoom(p.projectId), 'dependencyChanged', {
      fromIssueId: p.fromIssueId,
      toIssueId: p.toIssueId,
    });
  });

  on('issue.transitioned', (p) => {
    pub(projectRoom(p.projectId), 'issue.statusChanged', {
      issueId: p.id,
      from: p.from,
      to: p.to,
      actorId: p.actor.id,
      reason: p.reason,
      at: p.at,
    });
  });

  on('issue.created', (p) => {
    pub(projectRoom(p.projectId), 'issue.created', {
      issueId: p.issueId,
      projectId: p.projectId,
      actorId: p.actor.id,
    });
  });

  on('issue.updated', (p) => {
    pub(projectRoom(p.projectId), 'issue.updated', {
      issueId: p.issueId,
      projectId: p.projectId,
      fields: p.fields,
      actorId: p.actor.id,
    });
  });

  on('notification.created', (p) => {
    pub(userRoom(p.userId), 'notification.created', {
      notificationId: p.notificationId,
      userId: p.userId,
      projectId: p.projectId,
      type: p.type,
      title: p.title,
      // ISS-1063 — false only for a record joining a grouped delivery somebody has
      // already been interrupted by. Absent on the payload means yes, so every emitter
      // that predates grouping keeps announcing.
      announce: p.announce !== false,
      // ISS-510 — body + severity drive the realtime toast (description +
      // tone) and the browser-notification body without a follow-up fetch.
      body: p.body ?? null,
      severity: p.severity ?? null,
      issueId: p.issueId,
      secondaryIssueId: p.secondaryIssueId ?? null,
      agentSessionId: p.agentSessionId,
    });

    if (p.type === 'pipeline_wedge' && p.projectId) {
      pub(projectRoom(p.projectId), 'pipeline.wedge', {
        notificationId: p.notificationId,
        projectId: p.projectId,
        issueId: p.issueId,
        secondaryIssueId: p.secondaryIssueId ?? null,
        title: p.title,
        userId: p.userId,
      });
    }
  });

  on('notification.read', (p) => {
    pub(userRoom(p.userId), 'notification.read', {
      notificationId: p.notificationId,
      userId: p.userId,
    });
  });

  on('user.preferencesChanged', (p) => {
    pub(userRoom(p.userId), 'user.preferencesChanged', {
      userId: p.userId,
      theme: p.theme,
      language: p.language,
    });
  });

  // Explicit skill push → one `skill.sync` command per targeted device room, the ONLY path that
  // tells a device to pull skills. Carries no skill bodies — the device pulls its effective
  // manifest over REST and reports installed hashes back.
  on('skill.syncRequested', (p) => {
    for (const id of p.deviceIds) {
      pub(deviceRoom(id), 'skill.sync', {
        projectId: p.projectId,
        projectSlug: p.projectSlug,
        skillNames: p.skillNames,
      });
    }
  });

  on('runner.provisionRequested', (p) => {
    pub(deviceRoom(p.deviceId), 'provision.request', {
      projectId: p.projectId,
      runnerId: p.runnerId,
    });
  });

  // Device reported provision progress → project room live stepper.
  on('runner.provisionStatus', (p) => {
    pub(projectRoom(p.projectId), 'runner.provision', {
      runnerId: p.runnerId,
      deviceId: p.deviceId,
      projectId: p.projectId,
      status: p.status,
      detail: p.detail,
    });
  });

  on('integration.changed', (p) => {
    pub(projectRoom(p.projectId), 'integration.changed', p);
  });
}
