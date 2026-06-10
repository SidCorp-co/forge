/**
 * ISS-119 — Decomposition lifecycle hook subscribers.
 *
 * Three handlers ride the `transition` topic:
 *
 *  1. cascade approve   — parent enters `approved` (from the review gate
 *                         `waiting`, or tolerantly `on_hold`/`confirmed`) and
 *                         flips all parked children (`draft` or `on_hold`) →
 *                         `approved`.
 *  2. watcher           — when the LAST sibling reaches
 *                         {staging, released, closed}, post a system comment
 *                         on the parent and re-fire the parent's pipeline so
 *                         forge-test runs the integration step on merged
 *                         children code.
 *  3. close cascade     — parent → `closed` forces non-closed children to
 *                         `closed` (cleanup when the epic is abandoned).
 *
 * Children's status changes are routed through `applyStatusTransition` so
 * the standard state-machine guard (with `{ skip: true }` for collapsing
 * non-one-hop transitions, mirroring `autoSkipDisabledStages`), pipeline_run
 * lifecycle hooks, hook re-emission, and WS broadcasts all run for free.
 *
 * Registered AFTER `registerPipelineOrchestrator` so the parent's own
 * transition gets its auto-stage enqueue first; the decomposition fan-out
 * runs second within the same `bus.emit` invocation.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, comments, issues, projects } from '../db/schema.js';
import { type DeviceLite, applyStatusTransition } from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import {
  DECOMP_CHILD_READY_STATUSES,
  allChildrenReady,
  findDecompositionChildren,
  findDecompositionParent,
} from './decomposition.js';
import type { HookPayloads, HooksBus } from './hooks.js';
import { triggerPipelineStepManual } from './orchestrator.js';

/**
 * Synthesise a device principal for system-initiated cascades. Mirrors the
 * orchestrator's `resolveSkipDevice` pattern — we attribute cascade
 * transitions to the project creator (`projects.createdBy`, audit-only) so
 * `activity_log.actorId` and the WS broadcast's `actorId` carry a real
 * (non-null) user.
 */
async function resolveDeviceForProject(projectId: string): Promise<DeviceLite | null> {
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row?.createdBy) return null;
  return { id: row.createdBy, ownerId: row.createdBy };
}

/**
 * Statuses a child can be in when we cascade-approve. Both `draft` and
 * `on_hold` are accepted parking states:
 *   - `draft`   — the inert proposal state new core paths use.
 *   - `on_hold` — what the forge-plan skill still creates children at via
 *                 `forge_issues.create { status: 'on_hold' }`. Skills are
 *                 explicit-sync + per-project-overridable, so children keep
 *                 arriving as `on_hold` in the wild; the cascade MUST handle
 *                 both or those children strand at approval (regression seen
 *                 on dodgeprint ISS-4, 2026-06-01).
 * Neither has a STATUS_TO_JOB_TYPE entry, so the orchestrator never
 * auto-dispatches them before the cascade fires. Children that have already
 * moved past parking (e.g. promoted manually) are skipped.
 */
const CASCADE_APPROVE_FROM_STATUSES: ReadonlySet<IssueStatus> = new Set(['draft', 'on_hold']);

/**
 * Parent statuses from which entering `approved` should fire the cascade.
 * `waiting` is the canonical review-gate (set by `decomposeParent`). We also
 * tolerate `on_hold`, `confirmed` and `clarified` so a skill that parked the
 * parent off the happy path can't break the kickoff — the cascade is anchored
 * to the system-defined event (parent ENTERS `approved`), not to the skill
 * having set exactly one prior status.
 */
const CASCADE_APPROVE_PARENT_FROM: ReadonlySet<IssueStatus> = new Set([
  'waiting',
  'on_hold',
  'confirmed',
  'clarified',
]);

async function handleCascadeApprove(payload: HookPayloads['transition']): Promise<void> {
  if (!(payload.to === 'approved' && CASCADE_APPROVE_PARENT_FROM.has(payload.from))) return;
  const children = await findDecompositionChildren(payload.issueId);
  if (children.length === 0) return;
  const device = await resolveDeviceForProject(payload.projectId);
  if (!device) {
    logger.warn(
      { parentId: payload.issueId, projectId: payload.projectId },
      'decomposition: cascade approve skipped — no project owner to attribute',
    );
    return;
  }

  let cascaded = 0;
  for (const child of children) {
    if (!CASCADE_APPROVE_FROM_STATUSES.has(child.status)) continue;
    try {
      await applyStatusTransition(
        {
          id: child.id,
          projectId: child.projectId,
          status: child.status,
          reopenCount: 0,
        },
        'approved',
        device,
        { skip: true },
      );
      cascaded++;
    } catch (err) {
      logger.warn(
        { err, parentId: payload.issueId, childId: child.id, from: child.status },
        'decomposition: cascade approve failed for child',
      );
    }
  }

  if (isSentryEnabled()) {
    Sentry.addBreadcrumb({
      category: 'decomposition.cascade.fire',
      level: 'info',
      message: `cascade approve: ${cascaded}/${children.length} children`,
      data: {
        parentId: payload.issueId,
        projectId: payload.projectId,
        childCount: children.length,
        cascaded,
      },
    });
  }
}

async function handleWatcherChildrenReady(payload: HookPayloads['transition']): Promise<void> {
  if (!DECOMP_CHILD_READY_STATUSES.has(payload.to)) return;
  const parent = await findDecompositionParent(payload.issueId);
  if (!parent) return;
  const siblings = await findDecompositionChildren(parent.id);
  if (!allChildrenReady(siblings)) return;

  // Idempotency guard: the watcher posts at most one comment per parent
  // for the all-children-ready event. Without this, a later sibling
  // transition that re-satisfies `allChildrenReady` (e.g. staging→released)
  // would re-post and re-fire the parent pipeline.
  const sentinel = 'decomposition children reached staging';
  const [prior] = await db
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.issueId, parent.id), sql`${comments.body} ILIKE ${`%${sentinel}%`}`))
    .limit(1);
  if (prior) return;

  const device = await resolveDeviceForProject(parent.projectId);
  if (!device) {
    logger.warn(
      { parentId: parent.id, projectId: parent.projectId },
      'decomposition: watcher skipped — no project owner to attribute',
    );
    return;
  }

  await db.insert(comments).values({
    issueId: parent.id,
    authorId: device.ownerId,
    body: `All ${siblings.length} decomposition children reached staging — advancing parent to integration test on staging.`,
  });

  try {
    await triggerPipelineStepManual({
      projectId: parent.projectId,
      issueId: parent.id,
      status: parent.status,
      actor: { type: 'device', id: device.id },
      reason: {
        decomposition: 'children_ready',
        siblingCount: siblings.length,
        lastChildId: payload.issueId,
      },
    });
  } catch (err) {
    logger.warn(
      { err, parentId: parent.id, status: parent.status },
      'decomposition: parent re-trigger failed (likely active job exists or no skill registered)',
    );
  }

  if (isSentryEnabled()) {
    Sentry.addBreadcrumb({
      category: 'decomposition.watcher.complete',
      level: 'info',
      message: `watcher: all ${siblings.length} children ready`,
      data: {
        parentId: parent.id,
        parentStatus: parent.status,
        childCount: siblings.length,
        lastChildId: payload.issueId,
      },
    });
  }
}

async function handleCloseCascade(payload: HookPayloads['transition']): Promise<void> {
  if (payload.to !== 'closed') return;
  const children = await findDecompositionChildren(payload.issueId);
  if (children.length === 0) return;
  const device = await resolveDeviceForProject(payload.projectId);
  if (!device) {
    logger.warn(
      { parentId: payload.issueId, projectId: payload.projectId },
      'decomposition: close cascade skipped — no project owner to attribute',
    );
    return;
  }

  for (const child of children) {
    if (child.status === 'closed') continue;
    try {
      await applyStatusTransition(
        {
          id: child.id,
          projectId: child.projectId,
          status: child.status,
          reopenCount: 0,
        },
        'closed',
        device,
        { skip: true },
      );
    } catch (err) {
      logger.warn(
        { err, parentId: payload.issueId, childId: child.id, from: child.status },
        'decomposition: close cascade failed for child',
      );
    }
  }
}

/**
 * Subscribe all three handlers on the `transition` topic. The hooks bus
 * fires handlers in registration order, so cascade-approve / watcher /
 * close-cascade run sequentially per transition; only one applies to any
 * given (from, to) pair, so the three checks are cheap.
 */
export function registerDecompositionSubscribers(bus: HooksBus): void {
  bus.on('transition', async (payload) => {
    try {
      await handleCascadeApprove(payload);
    } catch (err) {
      logger.error(
        { err, issueId: payload.issueId, to: payload.to },
        'decomposition: cascade approve handler failed',
      );
    }
    try {
      await handleWatcherChildrenReady(payload);
    } catch (err) {
      logger.error(
        { err, issueId: payload.issueId, to: payload.to },
        'decomposition: watcher handler failed',
      );
    }
    try {
      await handleCloseCascade(payload);
    } catch (err) {
      logger.error(
        { err, issueId: payload.issueId, to: payload.to },
        'decomposition: close cascade handler failed',
      );
    }
  });
}
