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

  // An answer changes what every open page of its issue reads — "Needs an answer", the Answer action,
  // the run's word — and nothing else tells a browser it came (ISS-1228 round 22).
  bus.on('questionAnswered', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'question.answered',
      data: { questionId: p.questionId, projectId: p.projectId, issueId: p.issueId },
    });
  });

  registerCommentAndProjectFrames(bus);

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

  bus.on('runnerProvisionRequested', (p) => {
    roomManager.publish(deviceRoom(p.deviceId), {
      event: 'provision.request',
      data: { projectId: p.projectId, runnerId: p.runnerId },
    });
  });

  // Device reported provision progress → project room live stepper.
  bus.on('runnerProvisionStatus', (p) => {
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

/** The frames an open issue page or a project's tabs need of a comment changing and a project going. */
function registerCommentAndProjectFrames(bus: HooksBus): void {
  // An open issue page re-reads its comments on these, and nothing sent them, so a comment anyone
  // else posted never appeared there (ISS-1228 r27). Ids only: a member's page reads the body itself.
  const commentFrame =
    (event: string) =>
    (p: { issueId: string; projectId: string; commentId: string; actor: { id: string } }) => {
      roomManager.publish(projectRoom(p.projectId), {
        event,
        data: {
          issueId: p.issueId,
          projectId: p.projectId,
          commentId: p.commentId,
          actorId: p.actor.id,
        },
      });
    };
  bus.on('commentCreated', commentFrame('comment.created'));
  bus.on('commentUpdated', commentFrame('comment.updated'));
  bus.on('commentDeleted', commentFrame('comment.deleted'));

  // A tab open on a deleted project counted its live sessions until it next read the list (ISS-1228 r27).
  bus.on('projectDeleted', (p) => {
    roomManager.publish(projectRoom(p.projectId), {
      event: 'project.deleted',
      data: { projectId: p.projectId },
    });
  });
}
