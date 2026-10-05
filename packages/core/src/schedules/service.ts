import type { ScheduleRefusalCode } from '@forge/contracts/schedules';
import { and, asc, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { SessionAsker } from '../agent-sessions/index.js';
import { refusalError } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { projects, type ScheduleKind, schedules } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import { requireHeld } from '../permissions/index.js';
import { nextRunFor, validateCron } from './cron.js';
import { dispatchScheduleRun } from './dispatch.js';
import { type LastFire, lastFires } from './fires.js';

const refuse = refuser<ScheduleRefusalCode>('SCHEDULE_REFUSED');

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

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

export async function getSchedule(id: string, actorUserId: string) {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  if (!row) throw notFound('schedule not found');

  const access = await loadProjectAccess(row.projectId, actorUserId);
  requireHeld(access, 'project.read');

  const last = await lastFires(row.projectId, [row.id]);
  return withLastFire(row, last.get(row.id));
}

interface CreateScheduleInput {
  projectId: string;
  name: string;
  cron: string;
  prompt?: string | undefined;
  kind?: ScheduleKind | undefined;
  script?: string | undefined;
  runner?: 'desktop' | undefined;
  enabled?: boolean | undefined;
  targetProjectSlug?: string | null | undefined;
  params?: Record<string, unknown> | null | undefined;
}

export async function createSchedule(input: CreateScheduleInput, actorUserId: string) {
  const access = await loadProjectAccess(input.projectId, actorUserId);
  requireHeld(access, 'project.admin');

  const validation = validateCron(input.cron);
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
  if (kind === 'release_batch' || kind === 'sentry_pull') {
    const set = (['prompt', 'script'] as const).filter((f) => input[f] != null);
    if (set.length > 0) {
      throw badRequest(`${set.join(', ')} must be omitted when kind is "${kind}"`);
    }
  }

  const enabled = input.enabled ?? true;
  const nextRunAt = enabled ? nextRunFor(input.cron) : null;

  // ISS-244 — desktop is the only runner supported on the new interactive
  // dispatch path. Pin to 'desktop' so newly-created schedules are dispatchable.
  // (Irrelevant for kind='script', which never touches the runner/device path.)
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
      params: (input.params as never) ?? null,
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
  runner?: 'desktop' | undefined;
  enabled?: boolean | undefined;
  targetProjectSlug?: string | null | undefined;
  params?: Record<string, unknown> | null | undefined;
}

export async function updateSchedule(id: string, patch: UpdateSchedulePatch, actorUserId: string) {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  if (!row) throw notFound('schedule not found');

  const access = await loadProjectAccess(row.projectId, actorUserId);
  requireHeld(access, 'project.admin');

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

  const updates: Record<string, unknown> = { updatedAt: new Date(), ownerId: actorUserId };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.prompt !== undefined) updates.prompt = patch.prompt;
  if (patch.kind !== undefined) updates.kind = patch.kind;
  if (patch.script !== undefined) updates.script = patch.script;
  if (patch.targetProjectSlug !== undefined) updates.targetProjectSlug = patch.targetProjectSlug;
  if (patch.params !== undefined) updates.params = patch.params;

  const cron = patch.cron ?? row.cron;
  const enabled = patch.enabled ?? row.enabled;

  if (patch.cron !== undefined) {
    const validation = validateCron(patch.cron);
    if (!validation.ok) {
      throw new HTTPException(400, {
        message: validation.error ?? 'invalid cron',
        cause: { code: 'INVALID_CRON' },
      });
    }
    updates.cron = patch.cron;
  }
  if (patch.enabled !== undefined) updates.enabled = patch.enabled;

  if (patch.cron !== undefined || patch.enabled !== undefined) {
    updates.nextRunAt = enabled ? nextRunFor(cron) : null;
  }

  const [updated] = await db.update(schedules).set(updates).where(eq(schedules.id, id)).returning();
  if (!updated) throw notFound('schedule not found');

  return updated;
}

export async function deleteSchedule(id: string, actorUserId: string): Promise<void> {
  const [row] = await db
    .select({ id: schedules.id, projectId: schedules.projectId })
    .from(schedules)
    .where(eq(schedules.id, id))
    .limit(1);
  if (!row) throw notFound('schedule not found');

  const access = await loadProjectAccess(row.projectId, actorUserId);
  requireHeld(access, 'project.admin');

  await db.delete(schedules).where(eq(schedules.id, id));
}

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
    },
    actor,
    ...(resolvedTarget ? { resolvedTarget } : {}),
  });

  if (!result.ok && result.reason === 'refused') throw refusalError(result.refusal);
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
