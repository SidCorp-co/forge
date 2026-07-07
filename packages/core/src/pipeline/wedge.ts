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
 * Spam guard: one UNREAD wedge notification per entity, keyed on the indexed
 * `resolution_key` column (`wedge:<entityId>`, ISS-510) rather than a body
 * marker — this keeps the visible body free of the entity id.
 *
 * ISS-619 — `title`/`summary`/`nextStep`/`secondaryIssueId` are OPTIONAL
 * business-language presentation fields. When a caller supplies them (today:
 * the dependency-stall detector in sweeper.ts), the notification shows a
 * plain-language title + a two-sentence body instead of the raw
 * `hop`/`entity`/`reason`/`action` template — the full technical detail still
 * goes to `logger.warn`/Sentry either way. Callers that don't supply them
 * (the ops-facing loop-monitor/stale-detector alarms) keep the original
 * technical template unchanged.
 *
 * Best-effort by contract: NEVER throws — surfacing must not break the reap
 * path that called it.
 */

import { and, eq } from 'drizzle-orm';
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
    const resolutionKey = `wedge:${ev.entityId}`;

    // Dedupe: an unread wedge for this entity already surfaces the problem.
    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, 'pipeline_wedge'),
          eq(notifications.read, false),
          eq(notifications.resolutionKey, resolutionKey),
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
