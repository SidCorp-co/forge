import { type ScheduleRefusalCode, scheduleWritePermission } from '@forge/contracts/schedules';
import { and, asc, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { SessionAsker } from '../agent-sessions/index.js';
import { refusalError } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { projects, type ScheduleKind, schedules } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { RefusalError, refuser } from '../lib/refusal.js';
import { badRequest, notFound } from '../middleware/route-errors.js';
import { requireHeld } from '../permissions/index.js';
import { isTimeZone, nextRunFor, validateCron } from './cron.js';
import { dispatchScheduleRun } from './dispatch.js';
import { type LastFire, lastFires } from './fires.js';
import { statusReportParamsOf } from './status-report-params.js';

const refuse = refuser<ScheduleRefusalCode>('SCHEDULE_REFUSED');

/** A zone the cron is read in, refused by name where this runtime cannot read one. */
function assertTimeZone(timeZone: string | null | undefined): void {
  if (timeZone && !isTimeZone(timeZone)) {
    throw new HTTPException(400, {
      message: `timeZone "${timeZone}" is not an IANA time zone (e.g. "Asia/Ho_Chi_Minh", "UTC")`,
      cause: { code: 'INVALID_TIME_ZONE' },
    });
  }
}

/** The kinds that run no prompt and no script: each names what it does on its own. */
const SELF_NAMED_KINDS: ReadonlySet<ScheduleKind> = new Set([
  'release_batch',
  'sentry_pull',
  'status_report',
]);

// Cross-project routing via `targetProjectSlug` would otherwise let a source
// project's admin plant jobs on any project they know the slug of. Require the
// actor to hold at least `member` on the target project before accepting the
// slug, both when persisting it (POST/PUT) and when manually triggering.
async function assertTargetProjectAccess(
  slug: string,
  userId: string,
): Promise<{ id: string; createdBy: string }> {
  const [target] = await db
    .select({ id: projects.id, createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  if (!target) {
    throw new HTTPException(400, {
      message: 'targetProjectSlug not found',
      cause: { code: 'INVALID_TARGET_PROJECT' },
    });
  }
  const access = await loadProjectAccess(target.id, userId);
  requireHeld(access, 'project.write');
  return target;
}

/** A schedule's last status, run and session, read from its newest fire. */
function withLastFire<T extends { id: string }>(row: T, fire: LastFire | undefined) {
  return {
    ...row,
    lastStatus: fire?.status ?? null,
    lastRunAt: fire?.startedAt ?? null,
    lastSessionId: fire?.sessionId ?? null,
  };
}

async function withLastFires<T extends { id: string }>(projectId: string, rows: T[]) {
  const last = await lastFires(projectId);
  return rows.map((r) => withLastFire(r, last.get(r.id)));
}

export async function listSchedules(projectId: string, actorUserId: string, enabled?: boolean) {
  const access = await loadProjectAccess(projectId, actorUserId);
  requireHeld(access, 'project.read');

  const conditions = [eq(schedules.projectId, projectId)];
  if (enabled !== undefined) conditions.push(eq(schedules.enabled, enabled));

  const rows = await db
    .select()
    .from(schedules)
    .where(and(...conditions))
    .orderBy(asc(schedules.createdAt));
  return withLastFires(projectId, rows);
}
interface CreateScheduleInput {
  projectId: string;
  name: string;
  cron: string;
  prompt?: string | undefined;
  kind?: ScheduleKind | undefined;
  script?: string | undefined;
  enabled?: boolean | undefined;
  targetProjectSlug?: string | null | undefined;
  params?: Record<string, unknown> | null | undefined;
  timeZone?: string | null | undefined;
}

export async function createSchedule(input: CreateScheduleInput, actorUserId: string) {
  const access = await loadProjectAccess(input.projectId, actorUserId);
  requireHeld(access, 'project.admin');

  assertTimeZone(input.timeZone);
  const validation = validateCron(input.cron, input.timeZone);
  if (!validation.ok) {
    throw new HTTPException(400, {
      message: validation.error ?? 'invalid cron',
      cause: { code: 'INVALID_CRON' },
    });
  }

  if (input.targetProjectSlug) {
    await assertTargetProjectAccess(input.targetProjectSlug, actorUserId);
  }

  const kind: ScheduleKind = input.kind ?? 'prompt';
  if (kind === 'script' && !input.script) {
    throw badRequest('script is required when kind is "script"');
  }
  if (kind === 'prompt' && !input.prompt) {
    throw badRequest('prompt is required when kind is "prompt"');
  }
  if (SELF_NAMED_KINDS.has(kind)) {
    const set = (['prompt', 'script'] as const).filter((f) => input[f] != null);
    if (set.length > 0) {
      throw badRequest(`${set.join(', ')} must be omitted when kind is "${kind}"`);
    }
  }
  if (kind === 'status_report' && input.targetProjectSlug) {
    throw badRequest(
      'targetProjectSlug must be omitted when kind is "status_report": it reports on its own project to its members',
    );
  }
  const params =
    kind === 'status_report'
      ? await statusReportParamsOf(input.projectId, input.params)
      : input.params;

  const enabled = input.enabled ?? true;
  const nextRunAt = enabled ? nextRunFor(input.cron, new Date(), input.timeZone) : null;

  const [inserted] = await db
    .insert(schedules)
    .values({
      projectId: input.projectId,
      name: input.name,
      cron: input.cron,
      prompt: kind === 'script' ? null : (input.prompt ?? null),
      kind,
      script: kind === 'script' ? (input.script ?? null) : null,
      enabled,
      targetProjectSlug: input.targetProjectSlug ?? null,
      nextRunAt,
      params: (params as never) ?? null,
      timeZone: input.timeZone ?? null,
      ownerId: actorUserId,
    })
    .returning();
  if (!inserted) throw new Error('schedules: insert returned no row');

  return inserted;
}

interface UpdateSchedulePatch {
  name?: string | undefined;
  cron?: string | undefined;
  prompt?: string | undefined;
  kind?: ScheduleKind | undefined;
  script?: string | undefined;
  enabled?: boolean | undefined;
  targetProjectSlug?: string | null | undefined;
  params?: Record<string, unknown> | null | undefined;
  timeZone?: string | null | undefined;
}

export async function updateSchedule(id: string, patch: UpdateSchedulePatch, actorUserId: string) {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  if (!row) throw notFound('schedule not found');

  const access = await loadProjectAccess(row.projectId, actorUserId);
  requireHeld(access, scheduleWritePermission(row.ownerId, actorUserId), 'changing a schedule');

  if (patch.targetProjectSlug !== undefined && patch.targetProjectSlug !== null) {
    await assertTargetProjectAccess(patch.targetProjectSlug, actorUserId);
  }

  // Cross-field consistency against the PERSISTED row, not just this patch —
  // a patch that only sets `enabled` must not be rejected, but the row must
  // never end up kind='script' with no script (or kind='prompt' with no
  // prompt), which would make every future dispatch fail silently at runtime.
  const effectiveKind: ScheduleKind = patch.kind ?? row.kind;
  const effectiveScript = patch.script !== undefined ? patch.script : row.script;
  const effectivePrompt = patch.prompt !== undefined ? patch.prompt : row.prompt;
  if (effectiveKind === 'script' && !effectiveScript) {
    throw badRequest('script is required when kind is "script"');
  }
  if (effectiveKind === 'prompt' && !effectivePrompt) {
    throw badRequest('prompt is required when kind is "prompt"');
  }
  const effectiveTarget =
    patch.targetProjectSlug !== undefined ? patch.targetProjectSlug : row.targetProjectSlug;
  if (effectiveKind === 'status_report' && effectiveTarget) {
    throw badRequest(
      'targetProjectSlug must be omitted when kind is "status_report": it reports on its own project to its members',
    );
  }
  const effectiveParams =
    effectiveKind === 'status_report'
      ? await statusReportParamsOf(
          row.projectId,
          patch.params !== undefined ? patch.params : row.params,
        )
      : patch.params;
  assertTimeZone(patch.timeZone);
  const timeZone = patch.timeZone !== undefined ? patch.timeZone : row.timeZone;

  const updates: Record<string, unknown> = { updatedAt: new Date(), ownerId: actorUserId };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.prompt !== undefined) updates.prompt = patch.prompt;
  if (patch.kind !== undefined) updates.kind = patch.kind;
  if (patch.script !== undefined) updates.script = patch.script;
  if (patch.targetProjectSlug !== undefined) updates.targetProjectSlug = patch.targetProjectSlug;
  if (patch.params !== undefined || effectiveKind === 'status_report') {
    updates.params = effectiveParams ?? null;
  }
  if (patch.timeZone !== undefined) updates.timeZone = patch.timeZone;

  const cron = patch.cron ?? row.cron;
  const enabled = patch.enabled ?? row.enabled;

  if (patch.cron !== undefined) {
    const validation = validateCron(patch.cron, timeZone);
    if (!validation.ok) {
      throw new HTTPException(400, {
        message: validation.error ?? 'invalid cron',
        cause: { code: 'INVALID_CRON' },
      });
    }
    updates.cron = patch.cron;
  }
  if (patch.enabled !== undefined) updates.enabled = patch.enabled;

  if (patch.cron !== undefined || patch.enabled !== undefined || patch.timeZone !== undefined) {
    updates.nextRunAt = enabled ? nextRunFor(cron, new Date(), timeZone) : null;
  }

  const [updated] = await db.update(schedules).set(updates).where(eq(schedules.id, id)).returning();
  if (!updated) throw notFound('schedule not found');

  return updated;
}

export async function deleteSchedule(id: string, actorUserId: string): Promise<void> {
  const [row] = await db
    .select({ id: schedules.id, projectId: schedules.projectId, ownerId: schedules.ownerId })
    .from(schedules)
    .where(eq(schedules.id, id))
    .limit(1);
  if (!row) throw notFound('schedule not found');

  const access = await loadProjectAccess(row.projectId, actorUserId);
  requireHeld(access, scheduleWritePermission(row.ownerId, actorUserId), 'deleting a schedule');

  await db.delete(schedules).where(eq(schedules.id, id));
}

/** What a fire core runs itself is called in the answer naming why it failed. */
const RUN_NOUN: Partial<Record<ScheduleKind, string>> = {
  script: 'script',
  release_batch: 'release cut',
  sentry_pull: 'Sentry pull',
};

/** A manual run acts as the person who pressed it, bounded by the token they pressed it with. */
export async function runScheduleNow(
  id: string,
  actor: SessionAsker,
): Promise<{ fireId: string; sessionId: string | null; message: string }> {
  const actorUserId = actor.userId;
  const [schedule] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  if (!schedule) throw notFound('schedule not found');

  const access = await loadProjectAccess(schedule.projectId, actorUserId);
  requireHeld(access, 'project.write');

  // Defensive re-check: rows persisted before the create/update gate landed
  // could carry a `targetProjectSlug` the actor has no business triggering.
  let resolvedTarget: { id: string; createdBy: string } | undefined;
  if (schedule.targetProjectSlug) {
    resolvedTarget = await assertTargetProjectAccess(schedule.targetProjectSlug, actorUserId);
  }

  const result = await dispatchScheduleRun({
    schedule: {
      id: schedule.id,
      name: schedule.name,
      projectId: schedule.projectId,
      prompt: schedule.prompt,
      targetProjectSlug: schedule.targetProjectSlug ?? null,
      params: (schedule.params as Record<string, unknown> | null) ?? null,
      kind: schedule.kind,
      script: schedule.script ?? null,
      ownerId: schedule.ownerId,
      cron: schedule.cron,
      timeZone: schedule.timeZone,
    },
    actor,
    ...(resolvedTarget ? { resolvedTarget } : {}),
  });

  if (!result.ok && result.reason === 'refused') throw refusalError(result.refusal);
  if (!result.ok && result.reason === 'rule-refused') {
    throw new RefusalError([result.refusal], 'SCHEDULE_REFUSED');
  }
  if (!result.ok && result.reason === 'run-failed') {
    throw refuse(
      'SCHEDULE_RUN_FAILED',
      `the ${RUN_NOUN[schedule.kind] ?? 'run'} ran and failed: ${result.error} (fire ${result.fireId})`,
    );
  }
  if (!result.ok) {
    // ISS-244 — manual /run no longer queues; surface "no device online"
    // synchronously so the user knows nothing was started.
    throw refuse(
      'SCHEDULE_DISPATCH_FAILED',
      `nothing was started: ${result.reason} (fire ${result.fireId})`,
    );
  }

  return { fireId: result.fireId, sessionId: result.sessionId, message: 'Schedule triggered' };
}
