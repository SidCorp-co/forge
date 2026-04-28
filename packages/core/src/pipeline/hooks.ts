import type { IssueStatus } from '../db/schema.js';
import { logger } from '../logger.js';
import type { Actor } from './activity.js';

export interface IssueSnapshot {
  title: string;
  description: string | null;
  priority: string;
  category: string | null;
  assigneeId: string | null;
  labels: string[];
}

export interface HookPayloads {
  issueCreated: {
    issueId: string;
    projectId: string;
    actor: Actor;
    snapshot: IssueSnapshot;
  };
  issueUpdated: {
    issueId: string;
    projectId: string;
    actor: Actor;
    fields: string[];
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  };
  transition: {
    issueId: string;
    projectId: string;
    actor: Actor;
    from: IssueStatus;
    to: IssueStatus;
    reason?: string;
    reopenCount: number;
  };
  commentCreated: {
    issueId: string;
    projectId: string;
    actor: Actor;
    commentId: string;
    body: string;
    // Optional: existing emit sites pre-date threading. Treat undefined and
    // null as "top-level". The activity logger only records this when set.
    parentId?: string | null;
  };
  commentUpdated: {
    issueId: string;
    projectId: string;
    actor: Actor;
    commentId: string;
    before: string;
    after: string;
  };
  commentDeleted: {
    issueId: string;
    projectId: string;
    actor: Actor;
    commentId: string;
  };
  commentMentioned: {
    issueId: string;
    projectId: string;
    commentId: string;
    actor: Actor;
    mentionedUserIds: string[];
  };
  skillSynced: {
    projectId: string;
    deviceId: string;
    added: string[];
    updated: string[];
    unchanged: string[];
    removed: string[];
  };
  skillRegistered: {
    projectId: string;
    skillId: string;
    actorUserId: string;
    stage: string | null;
  };
  // v1 EPIC 6 — fired when a project skill override is created, updated, or
  // deleted. The WS broadcaster bridges this to the `skill.updated` event in
  // the project room so the web Skills page can invalidate its cache and the
  // packages/dev sync engine (PR-c) can resync the affected SKILL.md file.
  skillUpdated: {
    projectId: string;
    skillId: string;
    name: string;
    action: 'upsert' | 'delete';
    contentHash: string | null;
    actorUserId: string;
  };
  taskCreated: {
    taskId: string;
    issueId: string;
    projectId: string;
    actor: Actor;
  };
  taskUpdated: {
    taskId: string;
    issueId: string;
    projectId: string;
    actor: Actor;
    fields: string[];
  };
  taskDeleted: {
    taskId: string;
    issueId: string;
    projectId: string;
    actor: Actor;
  };
  scheduleRun: {
    scheduleId: string;
    projectId: string;
    jobId: string;
    actorUserId: string;
  };
  notificationCreated: {
    notificationId: string;
    userId: string;
    projectId: string | null;
    type: string;
    title: string;
    issueId: string | null;
    agentSessionId: string | null;
  };
  notificationRead: {
    notificationId: string;
    userId: string;
  };
  userPreferencesChanged: {
    userId: string;
    theme: string;
    language: string;
  };
}

export type HookTopic = keyof HookPayloads;
export type HookHandler<T extends HookTopic> = (payload: HookPayloads[T]) => void | Promise<void>;

type AnyHandler = (payload: unknown) => void | Promise<void>;

export class HooksBus {
  private readonly handlers = new Map<HookTopic, Set<AnyHandler>>();

  /**
   * Subscribe to a hook topic. Handlers fire in registration order
   * (deterministic — do not parallelise).
   */
  on<T extends HookTopic>(topic: T, handler: HookHandler<T>): () => void {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    const wrapped = handler as unknown as AnyHandler;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }

  async emit<T extends HookTopic>(topic: T, payload: HookPayloads[T]): Promise<void> {
    const set = this.handlers.get(topic);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      try {
        await handler(payload);
      } catch (err) {
        logger.error({ err, topic }, 'hook subscriber threw — continuing');
      }
    }
  }

  /** Test-only: drop all handlers. Never call from production code. */
  reset(): void {
    this.handlers.clear();
  }
}

export const hooks = new HooksBus();
