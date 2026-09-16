/**
 * ISS-452 (ISS-442 C6 / invariant I7) — no silent wedge.
 *
 * `emitPipelineWedge` is the single surfacing point for a non-progressing
 * kernel state: the loop monitor's miss-handlers and the demoted sweepers'
 * alarm passes call it when a hop exceeds its threshold. It writes a
 * `pipeline_wedge` notification to the project owner carrying WHERE + WHY +
 * WHAT to do; the `notificationCreated` hook fans it out to the owner's user
 * room AND the project room. These rows are also the raw signal behind the
 * interventions-per-issue metric (`issue_intervention_events`, migration
 * 0117).
 *
 * Spam guard: at most one UNRESOLVED wedge per entity per
 * {@link WEDGE_RENOTIFY_MS}, keyed on `resolution_key`; `resolvePipelineWedge`
 * clears it. A self-clearing condition should not reach here at all — the
 * caller knows (`holdResumesItself` in `jobs/hold.ts`).
 *
 * ISS-619 — `title`/`summary`/`nextStep`/`secondaryIssueId` are optional
 * business-language fields; without them the technical template is used. Never throws.
 */

import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { resolveNotifications } from '../notifications/auto-resolve.js';
import { createNotification } from '../notifications/routes.js';

/**
 * Shortest gap between two wedge notifications about the SAME entity.
 */
export const WEDGE_RENOTIFY_MS = 24 * 60 * 60_000;

export function wedgeResolutionKey(entityId: string): string {
  return `wedge:${entityId}`;
}

/**
 * Entity id for a capacity outage: the subject is a project's runner pool, not
 * any one job.
 */
export function capacityWedgeEntityId(projectId: string, stageKey: string): string {
  return `capacity:${projectId}:${stageKey}`;
}

/**
 * Entity id for a review loop going round without landing: the subject is one
 * run's rejection streak, not the issue.
 */
export function reviewRoundsWedgeEntityId(runId: string): string {
  return `rounds:${runId}`;
}

/**
 * Entity id for work frozen behind a paused run: the subject is the pause, not
 * any one of the steps queued behind it.
 */
export function pausedRunWedgeEntityId(runId: string): string {
  return `paused:${runId}`;
}

/**
 * Clear the wedge notifications for `entityId` — the condition they reported is
 * gone. Call it from whatever observes the recovery, or from a pass that
 * RE-DERIVES the condition and finds it absent; never on a timer that clears
 * blind, which is a bell emptied on a schedule rather than on a fact.
 */
export async function resolvePipelineWedge(entityId: string): Promise<number> {
  return resolveNotifications(wedgeResolutionKey(entityId));
}

export type WedgeHop = 'ack' | 'claim' | 'heartbeat' | 'result' | 'dispatch';

export interface PipelineWedgeEvent {
  projectId: string;
  issueId?: string | null;
  /** WHERE — which loop hop missed. */
  hop: WedgeHop;
  entity: 'job' | 'session' | 'run' | 'outbox' | 'issue' | 'capacity' | 'runner';
  entityId: string;
  /** WHY — what the detector saw (technical; logged, and used as the body fallback). */
  reason: string;
  /** WHAT — the human next step (technical; logged, and used as the body fallback). */
  action: string;
  /** Business-language title naming the stuck work (ISS-xx + title, no internal vocab). */
  title?: string;
  /** Business-language "what's happening" sentence. */
  summary?: string;
  /** Business-language "what to do" sentence. */
  nextStep?: string;
  /** The actionable blocker/child issue, when it differs from `issueId`. */
  secondaryIssueId?: string | null;
}

export async function emitPipelineWedge(ev: PipelineWedgeEvent): Promise<void> {
  try {
    const resolutionKey = wedgeResolutionKey(ev.entityId);

    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, 'pipeline_wedge'),
          eq(notifications.resolutionKey, resolutionKey),
          isNull(notifications.resolvedAt),
          gt(notifications.createdAt, new Date(Date.now() - WEDGE_RENOTIFY_MS)),
        ),
      )
      .limit(1);
    if (existing) return;

    const [project] = await db
      .select({ createdBy: projects.createdBy })
      .from(projects)
      .where(eq(projects.id, ev.projectId))
      .limit(1);
    if (!project) {
      logger.warn({ projectId: ev.projectId }, 'wedge: project not found, dropping event');
      return;
    }

    const title = ev.title ?? `Pipeline wedge: ${ev.hop} hop miss on ${ev.entity}`;
    const body = ev.summary
      ? [ev.summary, ev.nextStep ? `Next: ${ev.nextStep}` : null].filter(Boolean).join('\n')
      : [
          `WHERE: ${ev.hop} hop, ${ev.entity} ${ev.entityId}`,
          `WHY: ${ev.reason}`,
          `WHAT: ${ev.action}`,
        ].join('\n');

    await createNotification({
      userId: project.createdBy,
      projectId: ev.projectId,
      type: 'pipeline_wedge',
      title,
      body,
      issueId: ev.issueId ?? null,
      secondaryIssueId: ev.secondaryIssueId ?? null,
      resolutionKey,
      agentSessionId: ev.entity === 'session' ? ev.entityId : null,
    });

    logger.warn(
      {
        projectId: ev.projectId,
        issueId: ev.issueId ?? null,
        hop: ev.hop,
        entity: ev.entity,
        entityId: ev.entityId,
        reason: ev.reason,
      },
      'pipeline_wedge',
    );
  } catch (err) {
    logger.error({ err, entityId: ev.entityId, hop: ev.hop }, 'wedge: emit failed (dropped)');
  }
}
