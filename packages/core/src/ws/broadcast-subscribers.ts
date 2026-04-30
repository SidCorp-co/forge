import type { HooksBus } from '../pipeline/hooks.js';
import { globalRoom, projectRoom, userRoom } from './rooms.js';
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

  bus.on('taskCreated', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'task.created',
      data: {
        taskId: p.taskId,
        issueId: p.issueId,
        projectId: p.projectId,
        actorId: p.actor.id,
      },
    });
  });

  bus.on('taskUpdated', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'task.updated',
      data: {
        taskId: p.taskId,
        issueId: p.issueId,
        projectId: p.projectId,
        fields: p.fields,
        actorId: p.actor.id,
      },
    });
  });

  bus.on('taskDeleted', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'task.deleted',
      data: {
        taskId: p.taskId,
        issueId: p.issueId,
        projectId: p.projectId,
        actorId: p.actor.id,
      },
    });
  });

  bus.on('scheduleRun', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'schedule.run',
      data: {
        scheduleId: p.scheduleId,
        projectId: p.projectId,
        jobId: p.jobId,
        actorId: p.actorUserId,
      },
    });
  });

  bus.on('notificationCreated', (p) => {
    roomManager.publish(userRoom(p.userId), {
      event: 'notification.created',
      data: {
        notificationId: p.notificationId,
        userId: p.userId,
        projectId: p.projectId,
        type: p.type,
        title: p.title,
        issueId: p.issueId,
        agentSessionId: p.agentSessionId,
      },
    });
  });

  bus.on('notificationRead', (p) => {
    roomManager.publish(userRoom(p.userId), {
      event: 'notification.read',
      data: {
        notificationId: p.notificationId,
        userId: p.userId,
      },
    });
  });

  bus.on('userPreferencesChanged', (p) => {
    roomManager.publish(userRoom(p.userId), {
      event: 'user.preferencesChanged',
      data: {
        userId: p.userId,
        theme: p.theme,
        language: p.language,
      },
    });
  });

  bus.on('skillUpdated', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'skill.updated',
      data: {
        projectId: p.projectId,
        skillId: p.skillId,
        name: p.name,
        action: p.action,
        contentHash: p.contentHash,
        actorId: p.actorUserId,
      },
    });
  });

  bus.on('globalSkillUpdated', (p) => {
    roomManager.publish(globalRoom(), {
      event: 'skill.updated',
      data: {
        scope: 'global',
        name: p.name,
        oldVersion: p.oldVersion,
        newVersion: p.newVersion,
        contentHash: p.contentHash,
        changelog: p.changelog,
      },
    });
  });
}
