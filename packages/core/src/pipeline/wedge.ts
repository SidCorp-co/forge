/**
 * ISS-452 (ISS-442 C6 / invariant I7) — no silent wedge.
 *
 * `emitPipelineWedge` is the single surfacing point for a non-progressing
 * kernel state: the loop monitor's miss-handlers (jobs/loop-monitor.ts) and
 * the demoted sweepers' alarm passes call it when a hop exceeds its
 * threshold. It writes a `pipeline_wedge` notification to the project owner
 * carrying WHERE (which hop) + WHY (the reason) + WHAT a human should do;
 * the `notificationCreated` hook then fans it out to the owner's user room
 * AND the project room (ws/broadcast-subscribers.ts), so any operator with
 * the project open sees the wedge without a refresh.
 *
 * These notification rows are the raw signal behind the queryable
 * interventions-per-issue metric (`issue_intervention_events` view, migration
 * 0117; REST `GET /api/pipeline/interventions`) — VISION §1 metric ②
 * (interventions per issue closed) is counted from them plus the audited
 * manual escape hatches (C0 `job_events.kind='intervention'`, C1
 * `kernel_transitions` user-actor run flips).
 *
 * Spam guard: one UNREAD wedge notification per entity. The loop's
 * miss-handlers fire once per row (the reap flips it terminal), but the
 * demoted alarm passes re-match a missed row every tick — the dedupe keeps
 * that to a single open notification. The entity id is embedded in the body
 * (`[entity:<id>]` marker) and matched with LIKE, so no schema change is
 * needed.
 *
 * Best-effort by contract: NEVER throws — surfacing must not break the reap
 * path that called it.
 */

import { and, eq, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { createNotification } from '../notifications/routes.js';

export type WedgeHop = 'ack' | 'claim' | 'heartbeat' | 'result' | 'dispatch';

export interface PipelineWedgeEvent {
  projectId: string;
  issueId?: string | null;
  /** WHERE — which loop hop missed. */
  hop: WedgeHop;
  entity: 'job' | 'session' | 'run';
  entityId: string;
  /** WHY — what the detector saw. */
  reason: string;
  /** WHAT — the human next step. */
  action: string;
}

export async function emitPipelineWedge(ev: PipelineWedgeEvent): Promise<void> {
  try {
    const marker = `[entity:${ev.entityId}]`;

    // Dedupe: an unread wedge for this entity already surfaces the problem.
    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, 'pipeline_wedge'),
          eq(notifications.read, false),
          like(notifications.body, `%${marker}%`),
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

    await createNotification({
      userId: project.createdBy,
      projectId: ev.projectId,
      type: 'pipeline_wedge',
      title: `Pipeline wedge: ${ev.hop} hop miss on ${ev.entity}`,
      body: [
        `WHERE: ${ev.hop} hop, ${ev.entity} ${ev.entityId} ${marker}`,
        `WHY: ${ev.reason}`,
        `WHAT: ${ev.action}`,
      ].join('\n'),
      issueId: ev.issueId ?? null,
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
