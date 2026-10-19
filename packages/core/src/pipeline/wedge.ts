import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, devices, jobs, notifications, projects, runners } from '../db/schema.js';
import { logger } from '../logger.js';
import { resolveNotifications } from '../notifications/auto-resolve.js';
import { createNotification } from '../notifications/routes.js';
import { wedgeWordsFor } from './wedge-words.js';

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

export async function resolvePipelineWedge(entityId: string): Promise<number> {
  return resolveNotifications(wedgeResolutionKey(entityId));
}

export type WedgeHop = 'ack' | 'claim' | 'heartbeat' | 'result' | 'dispatch';

export interface PipelineWedgeEvent {
  projectId: string;
  issueId?: string | null;
  /** Which part of the loop missed. */
  hop: WedgeHop;
  entity: 'job' | 'session' | 'run' | 'outbox' | 'capacity' | 'runner';
  entityId: string;
  /** What the detector saw, in its own vocabulary: logged, never shown to a person. */
  reason: string;
  /** What an operator does about it, in the same vocabulary: logged beside `reason`. */
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

/**
 * ISS-1168 — what a wedge that names no issue is about, in the words a person already knows it by.
 *
 * A runner is the device the Runners page lists, so it is named by that device's name; a session by
 * its title (or its kind) and the device it ran on; a job by its step. Anything else is the
 * project's own, which the notification door names. Null where the row is gone or the wedge has an
 * issue, so the issue's reference leads instead.
 */
export async function wedgeSubjectName(
  ev: Pick<PipelineWedgeEvent, 'entity' | 'entityId' | 'issueId'>,
): Promise<string | null> {
  if (ev.issueId) return null;
  if (ev.entity === 'runner') {
    const [row] = await db
      .select({ device: devices.name, runner: runners.name })
      .from(runners)
      .leftJoin(devices, eq(devices.id, runners.deviceId))
      .where(eq(runners.id, ev.entityId))
      .limit(1);
    return row ? (row.device ?? row.runner) : null;
  }
  if (ev.entity === 'session') {
    const [row] = await db
      .select({ title: agentSessions.title, kind: agentSessions.kind, device: devices.name })
      .from(agentSessions)
      .leftJoin(devices, eq(devices.id, agentSessions.deviceId))
      .where(eq(agentSessions.id, ev.entityId))
      .limit(1);
    if (!row) return null;
    const what = row.title?.trim() || `${row.kind} session`;
    return row.device ? `${what} on ${row.device}` : what;
  }
  if (ev.entity === 'job') {
    const [row] = await db
      .select({ type: jobs.type })
      .from(jobs)
      .where(eq(jobs.id, ev.entityId))
      .limit(1);
    return row ? `${row.type} step` : null;
  }
  return null;
}

/**
 * ISS-1229 r16 — what a wedge is keyed on. Each kind has the one resolver `reevaluate-conditions.ts`
 * runs to end it once its subject is over, because a firing wedge holds every stuck-issue notice of
 * its project (`INHIBIT_RULES`) and one that nothing ends holds them for ever.
 */
export const WEDGE_KEY_KINDS = [
  'job',
  'session',
  'runner',
  'outbox',
  'capacity',
  'paused_run',
  'review_rounds',
] as const;
export type WedgeKeyKind = (typeof WEDGE_KEY_KINDS)[number];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The id shape each kind's key carries after `wedge:`, which its resolver reads back. */
export const WEDGE_KEY_SHAPES: Readonly<Record<WedgeKeyKind, RegExp>> = {
  job: new RegExp(`^${UUID}$`),
  session: new RegExp(`^${UUID}$`),
  runner: new RegExp(`^${UUID}$`),
  outbox: new RegExp(`^${UUID}$`),
  capacity: new RegExp(`^capacity:${UUID}:[a-z_]+$`),
  paused_run: new RegExp(`^paused:${UUID}$`),
  review_rounds: new RegExp(`^rounds:${UUID}$`),
};

/** The kind a wedge's entity and id key it as, or null where no resolver could ever end it. */
export function wedgeKeyKind(
  ev: Pick<PipelineWedgeEvent, 'entity' | 'entityId'>,
): WedgeKeyKind | null {
  const candidates: readonly WedgeKeyKind[] =
    ev.entity === 'run' ? ['paused_run', 'review_rounds'] : [ev.entity];
  return candidates.find((kind) => WEDGE_KEY_SHAPES[kind].test(ev.entityId)) ?? null;
}

export async function emitPipelineWedge(ev: PipelineWedgeEvent): Promise<void> {
  try {
    if (wedgeKeyKind(ev) === null) {
      logger.error(
        { projectId: ev.projectId, entity: ev.entity, entityId: ev.entityId, hop: ev.hop },
        `wedge: refused — no resolver ends a wedge keyed on ${ev.entity} "${ev.entityId}", and a wedge nothing ends holds its project's stuck-issue notices for ever`,
      );
      return;
    }
    const resolutionKey = wedgeResolutionKey(ev.entityId);

    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, 'pipeline_wedge'),
          eq(notifications.resolutionKey, resolutionKey),
          isNull(notifications.resolvedAt),
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

    const plain = wedgeWordsFor(ev.hop, ev.entity);
    const title = ev.title ?? plain.title;
    const body = ev.summary
      ? [ev.summary, ev.nextStep ? `Next: ${ev.nextStep}` : null].filter(Boolean).join('\n')
      : plain.body;

    await createNotification({
      userId: project.createdBy,
      projectId: ev.projectId,
      type: 'pipeline_wedge',
      title,
      body,
      issueId: ev.issueId ?? null,
      subject: await wedgeSubjectName(ev),
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
        action: ev.action,
      },
      'pipeline_wedge',
    );
  } catch (err) {
    logger.error({ err, entityId: ev.entityId, hop: ev.hop }, 'wedge: emit failed (dropped)');
  }
}
