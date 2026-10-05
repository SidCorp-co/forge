import { TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import { masterCharterPath } from '@forge/contracts/master-standing';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { runners } from '../db/schema.js';
import { issuesSettledBy } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { deviceRoom, roomManager } from '../lib/rooms.js';
import { consume } from '../outbox/index.js';

/** Every status a master can take work from, plus the two it reads to decide (promote, release). */
const MASTER_WAKE_STATUSES: readonly IssueStatus[] = [
  ...TAKEABLE_STATUSES,
  'draft',
  'awaiting_release',
];

// cm:why a wake names what fired it, and the runner (`daemon/master.rs:WakeSource`) refuses one it does not know by name, so a source added here without its reader is a loud line on the box, never a dropped signal
export const MASTER_WAKE_SOURCES = [
  'issue',
  'answer',
  'channel',
  'ecosystem_build',
  'workflow_design',
  'comment',
] as const;
type MasterWakeSource = (typeof MASTER_WAKE_SOURCES)[number];

function isMasterWakeStatus(status: IssueStatus): boolean {
  return MASTER_WAKE_STATUSES.includes(status);
}

/**
 * Every paired box bound to this project, deduplicated.
 *
 * One device may serve a project through more than one runner row, and each
 * box has exactly one device room — so a device listed twice would be woken
 * twice for one issue.
 */
async function devicesServing(projectId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ deviceId: runners.deviceId })
    .from(runners)
    .where(eq(runners.projectId, projectId));
  return rows.map((r) => r.deviceId);
}

export async function wakeMastersForProject(args: {
  projectId: string;
  issueId: string | null;
  status: IssueStatus;
}): Promise<{ boxes: number; delivered: number }> {
  return publishWake(args.projectId, {
    projectId: args.projectId,
    source: 'issue',
    issueId: args.issueId,
    status: args.status,
    // A pointer, not the charter itself (ISS-1313) — a reader taking only `projectId` is unaffected.
    charter: masterCharterPath(args.projectId),
  });
}

/**
 * Publish one `master.wake` per box because a question this project was
 * waiting on has been answered.
 */
async function wakeMastersForAnswer(args: {
  projectId: string;
  questionId: string;
}): Promise<{ boxes: number; delivered: number }> {
  return publishWake(args.projectId, {
    projectId: args.projectId,
    source: 'answer',
    issueId: null,
    questionId: args.questionId,
  });
}

async function wakeMastersForChannel(
  projectId: string,
): Promise<{ boxes: number; delivered: number }> {
  return publishWake(projectId, { projectId, source: 'channel' });
}

/** A builder run was opened for this project (a join or a push), and its master owes it (ISS-39). */
async function wakeMastersForBuild(
  projectId: string,
): Promise<{ boxes: number; delivered: number }> {
  return publishWake(projectId, { projectId, source: 'ecosystem_build' });
}

/** The approver decided a design this project proposed: an approve unblocks its builds, a return owes a revision. */
async function wakeMastersForDesign(args: {
  projectId: string;
  workflowId: string;
  decision: 'approve' | 'return';
  issueId: string | null;
}): Promise<{ boxes: number; delivered: number }> {
  return publishWake(args.projectId, {
    projectId: args.projectId,
    source: 'workflow_design',
    workflowId: args.workflowId,
    decision: args.decision,
    issueId: args.issueId,
  });
}

/** A person commented on one of this project's issues, and its master owes the thread a reply. */
async function wakeMastersForComment(args: {
  projectId: string;
  issueId: string;
  commentId: string;
}): Promise<{ boxes: number; delivered: number }> {
  return publishWake(args.projectId, {
    projectId: args.projectId,
    source: 'comment',
    issueId: args.issueId,
    commentId: args.commentId,
  });
}

async function publishWake(
  projectId: string,
  data: { projectId: string; source: MasterWakeSource } & Record<string, unknown>,
): Promise<{ boxes: number; delivered: number }> {
  try {
    const deviceIds = await devicesServing(projectId);
    let delivered = 0;
    for (const id of deviceIds) {
      delivered += roomManager.publish(deviceRoom(id), { event: 'master.wake', data });
    }
    if (delivered > 0) {
      logger.debug({ ...data, delivered }, 'master.wake published');
    } else {
      // ISS-1122 — published and acted on are different facts, and this room has no buffer and no
      // replay, so a wake nobody received is the one observable moment of an issue nothing on this
      // project will pick up.
      logger.warn(
        { ...data, boxes: deviceIds.length },
        'master.wake reached no listener — nothing on this project consumed it',
      );
    }
    return { boxes: deviceIds.length, delivered };
  } catch (err) {
    logger.warn({ err, projectId }, 'master.wake could not be published');
    return { boxes: 0, delivered: 0 };
  }
}

/**
 * Wake a project's boxes when an issue arrives at, or returns to, a status
 * that means there is something to look at.
 */
export function registerMasterWakeSubscribers(): void {
  consume('issue.transitioned', {
    name: 'master-wake',
    handle: async (p) => {
      if (!isMasterWakeStatus(p.to)) return;
      await wakeMastersForProject({ projectId: p.projectId, issueId: p.id, status: p.to });
    },
  });

  consume('issue.created', {
    name: 'master-wake',
    handle: async (p) => {
      if (!isMasterWakeStatus(p.status)) return;
      await wakeMastersForProject({ projectId: p.projectId, issueId: p.issueId, status: p.status });
    },
  });

  consume('workflow.designDecided', {
    name: 'master-wake',
    handle: async (p) => {
      await wakeMastersForDesign(p);
    },
  });

  consume('channel.documentPublished', {
    name: 'master-wake',
    handle: async (p) => {
      for (const side of p.to) await wakeMastersForChannel(side);
    },
  });

  consume('channel.threadHeld', {
    name: 'master-wake',
    handle: async (p) => {
      for (const side of p.parties) await wakeMastersForChannel(side);
    },
  });

  // The answer's own transaction wrote the event, so a wake is never lost to a crash after commit.
  consume('question.answered', {
    name: 'master-wake',
    handle: async (p) => {
      await wakeMastersForAnswer({ projectId: p.projectId, questionId: p.questionId });
    },
  });

  // The approval settled these waits in its own transaction; each issue it released is woken by name.
  consume('contract.versionApproved', {
    name: 'master-wake',
    handle: async (p) => {
      const released = await issuesSettledBy({
        providerProjectId: p.projectId,
        contractSlug: p.contractSlug,
        version: p.version,
      });
      for (const r of released) {
        if (r.held || !isMasterWakeStatus(r.status as IssueStatus)) continue;
        await wakeMastersForProject({
          projectId: r.projectId,
          issueId: r.issueId,
          status: r.status as IssueStatus,
        });
      }
    },
  });

  consume('ecosystem.buildOwed', {
    name: 'master-wake',
    handle: async (p) => {
      await wakeMastersForBuild(p.projectId);
    },
  });

  // cm:guard only a person's comment wakes: a master's own reply is agent-authored, so it can never
  // wake the master that wrote it, whatever status the issue is at.
  consume('comment.created', {
    name: 'master-wake',
    handle: async (p) => {
      if (p.authored !== 'human') return;
      await wakeMastersForComment({
        projectId: p.projectId,
        issueId: p.issueId,
        commentId: p.commentId,
      });
    },
  });
}
