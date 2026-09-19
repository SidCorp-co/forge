import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { runners } from '../db/schema.js';
import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { deviceRoom } from './rooms.js';
import { roomManager } from './server.js';

export const MASTER_WAKE_STATUSES: readonly IssueStatus[] = [
  'open',
  'draft',
  'awaiting_release',
] as const;

export function isMasterWakeStatus(status: IssueStatus): boolean {
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
    issueId: args.issueId,
    status: args.status,
  });
}

/**
 * Publish one `master.wake` per box because a question this project was
 * waiting on has been answered.
 */
export async function wakeMastersForAnswer(args: {
  projectId: string;
  questionId: string;
}): Promise<{ boxes: number; delivered: number }> {
  return publishWake(args.projectId, {
    projectId: args.projectId,
    issueId: null,
    questionId: args.questionId,
  });
}

async function publishWake(
  projectId: string,
  data: Record<string, unknown>,
): Promise<{ boxes: number; delivered: number }> {
  try {
    const deviceIds = await devicesServing(projectId);
    let delivered = 0;
    for (const id of deviceIds) {
      delivered += roomManager.publish(deviceRoom(id), { event: 'master.wake', data });
    }
    if (deviceIds.length > 0) {
      logger.debug({ ...data, delivered }, 'master.wake published');
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
export function registerMasterWakeSubscribers(bus: HooksBus): void {
  bus.on('transition', (p) => {
    if (!isMasterWakeStatus(p.to)) return;
    void wakeMastersForProject({ projectId: p.projectId, issueId: p.issueId, status: p.to });
  });

  bus.on('issueCreated', (p) => {
    if (!isMasterWakeStatus(p.status)) return;
    void wakeMastersForProject({ projectId: p.projectId, issueId: p.issueId, status: p.status });
  });
}
