/**
 * Core telling a box that a project has something to look at (ISS-933, wave 1).
 *
 * Until now nothing pushed: `daemon/master.rs` polls every project it serves on
 * a 30-second timer, and that interval IS the latency from an issue opening to
 * an agent touching it. This adds the push. It does not replace the poll and
 * must not — see the guard on `MASTER_WAKE_STATUSES` for why the timer is the
 * floor under a transport that drops.
 *
 * Publish-only, best-effort, and deliberately thin: the frame carries no work,
 * no token and no decision. It says "look now"; the box reads the pool through
 * the same path its timer already uses and decides for itself.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { runners } from '../db/schema.js';
import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { deviceRoom } from './rooms.js';
import { roomManager } from './server.js';

/**
 * The statuses whose arrival is worth waking a box for.
 *
 * `open` is the autonomous entry status — an issue reaching it has a run and a
 * `drive` job minted behind it, so there is claimable work this instant.
 * `draft` is what ISS-917 admits to a declared backlog, so a project that opted
 * in has something new to judge. `awaiting_release` is the hand-back: an issue leaving
 * a run frees the box that was holding it.
 */
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

/**
 * Publish one `master.wake` per box serving this project.
 *
 * Answers both numbers because they mean different things: `delivered` is 0
 * whenever every box is merely disconnected, while `boxes` at 0 means nothing
 * on the fleet is bound to do this project's work at all — the second is an
 * operator's problem and the first resolves itself on the next sweep.
 */
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
