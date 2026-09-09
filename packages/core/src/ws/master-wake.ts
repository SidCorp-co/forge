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
 * in has something new to judge. `released` is the hand-back: an issue leaving
 * a run frees the box that was holding it.
 */
// cm:guard this is a HINT and never the only trigger. `ws/rooms.ts:publish` is fire-and-forget — it returns 0 for a room with no subscriber and skips any socket not OPEN, with no buffer, no queue and no replay — so a wake published while a box's websocket is down is gone with nothing recording that it happened. The 30s sweep in `daemon/master.rs` is what makes a lost wake cost latency instead of costing the work, and the reconnect catch-up read on the runner side covers the same hole from the other end. Deleting either one turns a dropped frame into work that sits forever with nothing reporting why.
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/mod.rs — the `master.wake` arm on the device room. The event NAME and the `projectId` field are the whole contract; a runner that predates this ignores an unknown event and keeps polling, which is why this can ship before the fleet is on a build that reads it.
// cm:guard `releasing` is deliberately ABSENT while `released` is present, and the asymmetry IS the rule: `released` is an issue waiting for a person to trigger its release, which a master may see, while `releasing` is a batch already running — waking a master for one hands it a row `TERMINAL_FOR_DISPATCH` refuses, so every in-flight batch would nudge a box for nothing.
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
// cm:guard NO filter on `runners.status` here, and `draining` in particular must still be woken. Declining work is the BOX's act, not core's: `daemon/master.rs:accepts_new_work` is the only thing that reads the status, and its guard says core adding the same filter would hide work from a master rather than let the box decline it. A drained box still supervises a master that is already running and still owes its holds back, so it still needs the wake.
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
// cm:guard `issueId` is NULLABLE and the frame carries the null through. Since ISS-933 a wake also fires on the mint of a job kind with no issue behind it — `smoke`, `release_batch`, `reconcile`, `verify_skill` — and a wake carries no work anyway: `daemon/mod.rs` reads the event NAME and `projectId`, then reads the whole pool for itself.
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
// cm:guard the SAME event as an issue arrival, never a new name: `daemon/mod.rs` reads the event name and `projectId` off this frame and nothing else, so a `question.answered` name would be dropped by the `other =>` arm on every runner already on the fleet — and the master would learn of the answer only on its next 30s sweep. It carries no `status`, because an answer is not an issue status and widening that field would change a contract the runner does read (ISS-964 criterion 44).
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

// cm:guard never throw out of here. Every caller has already committed its own mutation — a transition, an issue insert, an answer — so an error raised here would turn recorded work into a 500 for a push that is only ever an optimisation over the box's own timer.
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
// cm:guard both arms, or half the arrivals are silent. `issueCreated` fires for an issue INSERTed straight at `open` or `draft` — a create never passes through `transition`, so a subscriber on `transition` alone would push nothing for the commonest way work arrives.
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
