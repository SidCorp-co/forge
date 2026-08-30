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
// cm:guard a re-notify FLOOR is required, and it must not be the read flag — the dedupe once matched `read = false`, so opening the notification re-armed it and the next monitor pass wrote another: read -> re-emit -> read, a closed loop that put 721 unresolved `pipeline_wedge` rows in the owner's bell (measured forge-beta 2026-08-14). Keying on `resolvedAt IS NULL` alone would swing the other way: with no resolve call for a key, the wedge would be emitted exactly once and never again.
export const WEDGE_RENOTIFY_MS = 24 * 60 * 60_000;

export function wedgeResolutionKey(entityId: string): string {
  return `wedge:${entityId}`;
}

/**
 * Entity id for a capacity outage: the subject is a project's runner pool, not
 * any one job.
 */
// cm:guard the `capacity:` prefix is load-bearing — `wedgeResolutionKey` keys ONLY on entityId, so a bare projectId here would share a dedup key with any pass that ever emits about a project, and the two would silently resolve each other. Prefixing keeps the namespace separate without touching the key format every existing unresolved row already carries.
// cm:guard key per POOL, not per project — with per-state device pools (`resolveStageOverrides`) `code` can be out of capacity while `triage` is fine, and a project-wide key would report the first outage and hide every other one. `stageKey` is `all` when no pool is in force, so the common case is still exactly one notification per project.
export function capacityWedgeEntityId(projectId: string, stageKey: string): string {
  return `capacity:${projectId}:${stageKey}`;
}

/**
 * Entity id for a review loop going round without landing: the subject is one
 * run's rejection streak, not the issue.
 */
// cm:guard the subject MUST be the run, never the issue id — `alarmChurningIssues` already emits under `wedge:<issueId>`, and the two passes count different things (total reopens vs consecutive rejections). Sharing a key would let whichever fired first silence the other, and `resolvePipelineWedge` on an approve would clear a churn wedge nobody resolved.
export function reviewRoundsWedgeEntityId(runId: string): string {
  return `rounds:${runId}`;
}

/**
 * Entity id for work frozen behind a paused run: the subject is the pause, not
 * any one of the steps queued behind it.
 */
// cm:guard the `paused:` prefix is load-bearing for the same reason `rounds:` is — `wedgeResolutionKey` keys ONLY on entityId, and `alarmRejectionStreaks` already emits about a run id. A bare runId here would share a dedup key with it, so whichever fired first would silence the other and either one's resolve would clear both.
// cm:edge lockstep -> packages/core/src/pipeline/paused-run-wedge-resolve.ts — that subscriber is the only caller that clears this key; a wedge emitted under a key nothing resolves is a permanent row in the owner's bell (721 of them, measured forge-beta 2026-08-14)
export function pausedRunWedgeEntityId(runId: string): string {
  return `paused:${runId}`;
}

/**
 * Clear the wedge notifications for `entityId` — the condition they reported is
 * gone. Call this from whatever observes the recovery, never on a timer.
 */
// cm:edge lockstep -> packages/core/src/pipeline/wedge.ts#emitPipelineWedge — the key both sides use comes from `wedgeResolutionKey`; a caller that hand-writes `wedge:<id>` here and the emitter drifting apart means a resolved wedge stays in the bell forever
export async function resolvePipelineWedge(entityId: string): Promise<number> {
  return resolveNotifications(wedgeResolutionKey(entityId));
}

export type WedgeHop = 'ack' | 'claim' | 'heartbeat' | 'result' | 'dispatch';

export interface PipelineWedgeEvent {
  projectId: string;
  issueId?: string | null;
  /** WHERE — which loop hop missed. */
  hop: WedgeHop;
  // cm:guard `issue` carries NO job/session id, so it only fits an alarm whose subject is the issue itself (RFC 0002 INV-7 churn) — the dedup key is `wedge:<entityId>`, so passing an issue id under `entity:'job'` silently makes the once-per-entity guard mean once-per-issue while the payload claims a job that does not exist
  // cm:guard `capacity` is the one entity whose id is NOT a row id — build it with `capacityWedgeEntityId`, never by hand, because its whole purpose is that many jobs hitting the same empty pool collapse into ONE notification. Passing a job id here would emit per failed job, which is the spam this type exists to avoid.
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
