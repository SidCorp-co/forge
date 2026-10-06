import type { ConsumedBy, OutboxConsumerOf } from '@forge/contracts/outbox-consumers';
import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import type { WsFrameName, WsFramePayloads } from '@forge/contracts/ws-frames';
import { refuser } from '../lib/refusal.js';
import { deviceRoom, projectRoom, roomManager, runnerRoom, userRoom } from '../lib/rooms.js';
import { consume } from '../outbox/index.js';
import { runStatusView } from '../pipeline/index.js';

const pub = (room: string, event: string, data: unknown) =>
  roomManager.publish(room, { event, data });

/** A frame web's event router reads, checked against the payload it expects. */
const frame = <E extends WsFrameName>(room: string, event: E, data: WsFramePayloads[E]) =>
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

const refuseFrame = refuser('SESSION_FRAME_AUDIENCE_MISSING');

/** A session frame written before its audience was recorded names no readers; refused by name rather than guessed project-wide. */
function assertAudience(event: string, userIds: unknown): void {
  if (!Array.isArray(userIds)) {
    throw refuseFrame(
      'SESSION_FRAME_AUDIENCE_MISSING',
      `${event} carries no userIds; it was written by a build older than the private-chat audience`,
    );
  }
}

export function registerWsBroadcastSubscribers(): void {
  // every open view of either side refetches the edge
  on('issue.dependency.changed', (p) => {
    frame(projectRoom(p.projectId), 'dependencyChanged', {
      fromIssueId: p.fromIssueId,
      toIssueId: p.toIssueId,
    });
  });

  on('issue.transitioned', (p) => {
    frame(projectRoom(p.projectId), 'issue.statusChanged', {
      issueId: p.id,
      from: p.from,
      to: p.to,
      actorId: p.actor.id,
      reason: p.reason,
      at: p.at,
    });
  });

  on('issue.created', (p) => {
    frame(projectRoom(p.projectId), 'issue.created', {
      issueId: p.issueId,
      projectId: p.projectId,
      actorId: p.actor.id,
    });
  });

  on('issue.updated', (p) => {
    frame(projectRoom(p.projectId), 'issue.updated', {
      issueId: p.issueId,
      projectId: p.projectId,
      fields: p.fields,
      actorId: p.actor.id,
    });
  });

  // an open thread refetches its comments and the issue's activity
  for (const type of ['comment.created', 'comment.updated', 'comment.deleted'] as const) {
    on(type, (p) => {
      frame(projectRoom(p.projectId), type, {
        issueId: p.issueId,
        projectId: p.projectId,
        commentId: p.commentId,
      });
    });
  }

  on('notification.created', (p) => {
    frame(userRoom(p.userId), 'notification.created', {
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
      severity: p.severity,
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
    frame(userRoom(p.userId), 'notification.read', {
      notificationId: p.notificationId,
      userId: p.userId,
    });
  });

  on('user.preferencesChanged', (p) => {
    frame(userRoom(p.userId), 'user.preferencesChanged', {
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
    frame(projectRoom(p.projectId), 'runner.provision', {
      runnerId: p.runnerId,
      deviceId: p.deviceId,
      projectId: p.projectId,
      status: p.status,
      detail: p.detail,
    });
  });

  on('integration.changed', (p) => {
    frame(projectRoom(p.projectId), 'integration.changed', p);
  });

  on('credential.tokenChanged', (p) => {
    frame(userRoom(p.userId), `pat.${p.change}`, {
      tokenId: p.tokenId,
      userId: p.userId,
      ts: p.ts,
    });
  });

  on('runner.changed', (p) => {
    if (p.runnerRoom) pub(runnerRoom(p.runnerId), p.event, p.data);
    pub(projectRoom(p.projectId), p.event, p.data);
  });

  on('job.changed', (p) => {
    if (p.rooms.includes('device') && p.deviceId) pub(deviceRoom(p.deviceId), p.event, p.data);
    if (p.rooms.includes('project')) pub(projectRoom(p.projectId), p.event, p.data);
  });

  on('device.pushed', (p) => {
    if (p.userId) pub(userRoom(p.userId), p.event, p.data);
    if (p.deviceId) pub(deviceRoom(p.deviceId), p.event, p.data);
  });

  on('session.pushed', (p) => {
    assertAudience(p.event, p.userIds);
    if (p.projectId) pub(projectRoom(p.projectId), p.event, p.data);
    if (p.deviceId) pub(deviceRoom(p.deviceId), p.event, p.data);
    for (const userId of p.userIds) pub(userRoom(userId), p.event, p.data);
  });

  on('issue.pushed', (p) => {
    pub(projectRoom(p.projectId), p.event, p.data);
  });

  on('conversation.pushed', (p) => {
    for (const userId of p.userIds) pub(userRoom(userId), p.event, p.data);
  });

  // a pause, a resume, a cancel and a close all reach the project room through the run's own move
  consume('run.transitioned', {
    name: 'run-status-broadcast',
    handle: async (p) => {
      const run = await runStatusView(p.id);
      if (run) frame(projectRoom(run.projectId), 'pipeline_run.status_changed', run);
    },
  });

  on('session.changed', (p) => {
    const data = {
      sessionId: p.sessionId,
      projectId: p.projectId,
      deviceId: p.deviceId,
      ...p.extra,
    };
    assertAudience(p.event, p.userIds);
    if (p.projectWide) {
      pub(projectRoom(p.projectId), p.event, data);
      if (p.deviceId) pub(deviceRoom(p.deviceId), p.event, data);
    }
    for (const userId of p.userIds) pub(userRoom(userId), p.event, data);
  });
}
