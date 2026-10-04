import type { ConsumedBy, OutboxConsumerOf } from '@forge/contracts/outbox-consumers';
import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { deviceRoom, globalRoom, projectRoom, roomManager, userRoom } from '../lib/rooms.js';
import { consume } from '../outbox/index.js';

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
  on('issue.transitioned', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'issue.statusChanged',
      data: {
        issueId: p.id,
        from: p.from,
        to: p.to,
        actorId: p.actor.id,
        reason: p.reason,
        at: p.at,
      },
    });
  });

  on('issue.created', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'issue.created',
      data: {
        issueId: p.issueId,
        projectId: p.projectId,
        actorId: p.actor.id,
      },
    });
  });

  on('issue.updated', (p) => {
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

  on('schedule.fired', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'schedule.run',
      data: {
        scheduleId: p.scheduleId,
        projectId: p.projectId,
        sessionId: p.sessionId,
        actorId: p.actorUserId,
      },
    });
  });

  on('notification.created', (p) => {
    roomManager.publish(userRoom(p.userId), {
      event: 'notification.created',
      data: {
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
      },
    });

    if (p.type === 'pipeline_wedge' && p.projectId) {
      roomManager.publish(projectRoom(p.projectId), {
        event: 'pipeline.wedge',
        data: {
          notificationId: p.notificationId,
          projectId: p.projectId,
          issueId: p.issueId,
          secondaryIssueId: p.secondaryIssueId ?? null,
          title: p.title,
          userId: p.userId,
        },
      });
    }
  });

  on('notification.read', (p) => {
    roomManager.publish(userRoom(p.userId), {
      event: 'notification.read',
      data: {
        notificationId: p.notificationId,
        userId: p.userId,
      },
    });
  });

  on('user.preferencesChanged', (p) => {
    roomManager.publish(userRoom(p.userId), {
      event: 'user.preferencesChanged',
      data: {
        userId: p.userId,
        theme: p.theme,
        language: p.language,
      },
    });
  });

  // Explicit skill push → one `skill.sync` command per targeted device room, the ONLY path that
  // tells a device to pull skills. Carries no skill bodies — the device pulls its effective
  // manifest over REST and reports installed hashes back.
  on('skill.syncRequested', (p) => {
    for (const id of p.deviceIds) {
      roomManager.publish(deviceRoom(id), {
        event: 'skill.sync',
        data: {
          projectId: p.projectId,
          projectSlug: p.projectSlug,
          skillNames: p.skillNames,
        },
      });
    }
  });

  on('runner.provisionRequested', (p) => {
    roomManager.publish(deviceRoom(p.deviceId), {
      event: 'provision.request',
      data: { projectId: p.projectId, runnerId: p.runnerId },
    });
  });

  // Device reported provision progress → project room live stepper.
  on('runner.provisionStatus', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'runner.provision',
      data: {
        runnerId: p.runnerId,
        deviceId: p.deviceId,
        projectId: p.projectId,
        status: p.status,
        detail: p.detail,
      },
    });
  });

  on('integration.changed', (p) => {
    roomManager.publish(projectRoom(p.projectId), { event: 'integration.changed', data: p });
  });

  on('skill.globalUpdated', (p) => {
    roomManager.publish(globalRoom(), {
      event: 'skill.updated',
      data: {
        scope: 'global',
        name: p.name,
        oldVersion: p.oldVersion,
        newVersion: p.newVersion,
        contentHash: p.contentHash,
      },
    });
  });
}
