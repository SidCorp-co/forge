import type { HooksBus } from '../pipeline/hooks.js';
import { deviceRoom, globalRoom, projectRoom, userRoom } from './rooms.js';
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
        sessionId: p.sessionId,
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

    // Epic 5 (ISS-21) — additionally fan out PM escalations to the project
    // room so any operator with the project open (not just the recipient
    // user) receives the prompt. The two publishes are intentional: the
    // user-room event drives the global notification badge; the project
    // event drives the in-context modal/banner.
    // ISS-452 (I7) — fan pipeline wedges out to the project room too, so any
    // operator with the project open sees the wedge banner (mirrors the
    // pm_escalation pattern below). The user-room event above still drives
    // the recipient's notification badge.
    if (p.type === 'pipeline_wedge' && p.projectId) {
      roomManager.publish(projectRoom(p.projectId), {
        event: 'pipeline.wedge',
        data: {
          notificationId: p.notificationId,
          projectId: p.projectId,
          issueId: p.issueId,
          title: p.title,
          userId: p.userId,
        },
      });
    }

    if (p.type === 'pm_escalation' && p.projectId) {
      roomManager.publish(projectRoom(p.projectId), {
        event: 'pm.escalation',
        data: {
          notificationId: p.notificationId,
          projectId: p.projectId,
          decisionId: p.decisionId ?? null,
          title: p.title,
          userId: p.userId,
        },
      });
    }
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

  // Explicit skill push → one `skill.sync` command per targeted device room.
  // This is the ONLY path that tells a device to pull skills; `skill.updated`
  // above is project-room cache-invalidation for the web UI only and must NOT
  // trigger a device to sync. Carries no skill bodies — the device pulls its
  // effective manifest over REST and reports installed hashes back.
  bus.on('skillSyncRequested', (p) => {
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

  // ISS-118 — skill_registrations changes affect the per-project skill
  // bindings that downstream clients (web Skills tab, dev runner) derive
  // from the pipeline registry. Broadcast `pipeline.registry_changed` so
  // subscribers refetch /api/pipeline/registry and pick up the new bindings
  // without a manual refresh.
  bus.on('skillRegistered', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'pipeline.registry_changed',
      data: {
        projectId: p.projectId,
        reason: 'skill_registration_changed',
        skillId: p.skillId,
        stage: p.stage,
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
      },
    });
  });
}
