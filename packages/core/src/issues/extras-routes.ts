import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  activityLog,
  type IssueStatus,
  issuePriorities,
  issueStatuses,
  issues,
  jobs,
  usageRecords,
} from '../db/schema.js';
import { sql } from 'drizzle-orm';
import { enqueueJob } from '../jobs/enqueue.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { recordActivityTx } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { ActiveJobConflictError, triggerPipelineStepManual } from '../pipeline/orchestrator.js';
import { SkillNotLoadableError } from '../pipeline/skill-loader.js';
import { openIssueRun } from '../pipeline/runs.js';
import {
  REOPEN_CAP,
  canTransition,
  isReopenEntry,
} from '../pipeline/state-machine.js';
import {
  TERMINAL_FOR_DISPATCH,
  publishIssueStatusChange,
  triggerTerminalDispatch,
} from './transition.js';

const idParamSchema = z.object({ id: z.uuid() });

const stageEnum = z.enum([
  'triage',
  'plan',
  'code',
  'review',
  'test',
  'fix',
  'release',
  'clarify',
]);
const runPipelineStepBodySchema = z
  .object({ stage: stageEnum.optional() })
  .strict();

const manualHoldBodySchema = z.object({ value: z.boolean() }).strict();

// `complexity` is intentionally omitted: BulkActionBar does not expose a
// complexity selector, so accepting it server-side would create a client/
// server surface mismatch. If a future bulk-complexity affordance lands,
// add `complexity` here AND in `BatchPatchData` on the web side.
const batchPatchBodySchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(100),
    data: z
      .object({
        status: z.enum(issueStatuses).optional(),
        priority: z.enum(issuePriorities).optional(),
        category: z.string().trim().min(1).max(100).nullable().optional(),
        manualHold: z.boolean().optional(),
      })
      .strict()
      .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' }),
  })
  .strict();

const pipelineTimingQuerySchema = z
  .object({
    projectId: z.uuid(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export const issueExtrasRoutes = new Hono<{ Variables: AuthVars }>();
issueExtrasRoutes.use('*', requireAuth(), assertEmailVerified());

type BatchSkipReason =
  | 'forbidden'
  | 'not_found'
  | 'illegal_transition'
  | 'no_op'
  | 'reopen_cap_exceeded'
  | 'stale';

type BatchResult = {
  updated: Array<{
    id: string;
    displayId: string;
    skipReason?: BatchSkipReason;
  }>;
  skipped: Array<{ id: string; reason: BatchSkipReason }>;
  failed: Array<{ id: string; error: string }>;
};

// PATCH /api/issues/batch — partial-success batch update across N issues.
// Each field uses the per-issue mutation path (transition / manual-hold /
// plain patch) so activity + WS semantics match the single-issue routes.
// Inaccessible or invalid rows land in `skipped`; one failure does not abort
// the rest. Registered before `/:id` so `/batch` matches ahead of the UUID.
issueExtrasRoutes.patch(
  '/batch',
  zValidator('json', batchPatchBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { ids, data } = c.req.valid('json');
    const userId = c.get('userId');
    const actor = { type: 'user' as const, id: userId };

    const result: BatchResult = { updated: [], skipped: [], failed: [] };

    const rows = await db
      .select({
        id: issues.id,
        issSeq: issues.issSeq,
        projectId: issues.projectId,
        status: issues.status,
        priority: issues.priority,
        category: issues.category,
        complexity: issues.complexity,
        manualHold: issues.manualHold,
        reopenCount: issues.reopenCount,
      })
      .from(issues)
      .where(inArray(issues.id, ids));

    const foundIds = new Set(rows.map((r) => r.id));
    for (const id of ids) {
      if (!foundIds.has(id)) result.skipped.push({ id, reason: 'not_found' });
    }

    // Pre-load project access for every distinct project in parallel. The
    // per-row loop below reads from the resolved map without re-awaiting,
    // so 100 issues across K projects cost K lookups concurrently rather
    // than K sequential round-trips. A 404 from `loadProjectAccess` (project
    // deleted between the issue read and the access read) is mapped to a
    // `not_found` skip instead of bubbling up to `failed`.
    const distinctProjects = [...new Set(rows.map((r) => r.projectId))];
    type ProjectAccessState = { allowed: boolean; missing?: boolean };
    const accessMap = new Map<string, ProjectAccessState>();
    const accessResolutions = await Promise.all(
      distinctProjects.map(async (projectId): Promise<[string, ProjectAccessState]> => {
        try {
          const access = await loadProjectAccess(projectId, userId);
          return [
            projectId,
            { allowed: !!(access.role || access.ownerId === userId) },
          ];
        } catch (err) {
          if (err instanceof HTTPException && err.status === 404) {
            return [projectId, { allowed: false, missing: true }];
          }
          throw err;
        }
      }),
    );
    for (const [projectId, state] of accessResolutions) {
      accessMap.set(projectId, state);
    }

    // Track terminal transitions across the batch so we can fan out the
    // Layer-2 dispatch tick once at the end (parent project + cross-project
    // children via outgoing `kind='blocks'` edges). A single inArray query
    // for the children read keeps the cost flat regardless of N.
    const terminalTransitions: Array<{
      issueId: string;
      projectId: string;
      issSeq: number;
      at: Date;
    }> = [];

    for (const row of rows) {
      const access = accessMap.get(row.projectId);
      if (access?.missing) {
        result.skipped.push({ id: row.id, reason: 'not_found' });
        continue;
      }
      if (!access?.allowed) {
        result.skipped.push({ id: row.id, reason: 'forbidden' });
        continue;
      }

      let touched = false;
      let skipReason: BatchSkipReason | null = null;

      try {
        if (data.status !== undefined) {
          const fromStatus = row.status as IssueStatus;
          const toStatus = data.status;
          if (toStatus === fromStatus) {
            // Single-issue `/transition` 409s on NO_OP. The batch surfaces
            // it via skipReason instead so callers can see that the status
            // request was a no-op even when other fields succeeded.
            skipReason = 'no_op';
          } else if (!canTransition(fromStatus, toStatus)) {
            skipReason = 'illegal_transition';
          } else if (
            isReopenEntry(fromStatus, toStatus) &&
            row.reopenCount >= REOPEN_CAP
          ) {
            // No `override` in batch — bulk bar has no UI for owner-bypass.
            skipReason = 'reopen_cap_exceeded';
          } else {
            const reopening = isReopenEntry(fromStatus, toStatus);
            const [updated] = await db
              .update(issues)
              .set({
                status: toStatus,
                reopenCount: reopening
                  ? sql`${issues.reopenCount} + 1`
                  : issues.reopenCount,
                updatedAt: sql`now()`,
              })
              .where(and(eq(issues.id, row.id), eq(issues.status, fromStatus)))
              .returning({
                id: issues.id,
                status: issues.status,
                reopenCount: issues.reopenCount,
                updatedAt: issues.updatedAt,
              });

            if (!updated) {
              skipReason = 'stale';
            } else {
              touched = true;
              row.status = toStatus;
              row.reopenCount = updated.reopenCount;
              await hooks.emit('transition', {
                issueId: row.id,
                projectId: row.projectId,
                actor,
                from: fromStatus,
                to: toStatus,
                reopenCount: updated.reopenCount,
              });
              publishIssueStatusChange(row.projectId, {
                issueId: row.id,
                from: fromStatus,
                to: toStatus,
                reopenCount: updated.reopenCount,
                actorId: userId,
                reason: null,
                at: updated.updatedAt,
              });
              if (TERMINAL_FOR_DISPATCH.has(toStatus)) {
                terminalTransitions.push({
                  issueId: row.id,
                  projectId: row.projectId,
                  issSeq: row.issSeq,
                  at: updated.updatedAt,
                });
              }
            }
          }
        }

        if (
          data.manualHold !== undefined &&
          row.manualHold !== data.manualHold
        ) {
          const before = row.manualHold;
          const value = data.manualHold;
          await db.transaction(async (tx) => {
            await tx
              .update(issues)
              .set({ manualHold: value, updatedAt: sql`now()` })
              .where(eq(issues.id, row.id));
            await recordActivityTx(tx, {
              issueId: row.id,
              actor,
              action: value
                ? 'issue.manualHold.set'
                : 'issue.manualHold.cleared',
              payload: { manualHold: value },
            });
          });
          row.manualHold = value;
          touched = true;
          await hooks.emit('issueUpdated', {
            issueId: row.id,
            projectId: row.projectId,
            actor,
            fields: ['manualHold'],
            before: { manualHold: before },
            after: { manualHold: value },
          });
        }

        const plainUpdates: Record<string, unknown> = {};
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        const changedFields: string[] = [];
        const plainFields = [
          { key: 'priority' as const, next: data.priority, current: row.priority },
          { key: 'category' as const, next: data.category, current: row.category },
        ];
        for (const f of plainFields) {
          if (f.next !== undefined && f.next !== f.current) {
            plainUpdates[f.key] = f.next;
            before[f.key] = f.current;
            after[f.key] = f.next;
            changedFields.push(f.key);
          }
        }
        if (changedFields.length > 0) {
          await db
            .update(issues)
            .set({ ...plainUpdates, updatedAt: sql`now()` })
            .where(eq(issues.id, row.id));
          touched = true;
          await hooks.emit('issueUpdated', {
            issueId: row.id,
            projectId: row.projectId,
            actor,
            fields: changedFields,
            before,
            after,
          });
        }
      } catch (err) {
        result.failed.push({
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (touched) {
        const entry: { id: string; displayId: string; skipReason?: BatchSkipReason } = {
          id: row.id,
          displayId: `ISS-${row.issSeq}`,
        };
        // A status request that was rejected for this issue (no_op, illegal,
        // reopen-cap, stale) must not be silently swallowed when other fields
        // (priority/category/manualHold) succeeded. Surface it on the updated
        // entry so the caller can show a partial-success diagnostic.
        if (skipReason) entry.skipReason = skipReason;
        result.updated.push(entry);
      } else if (skipReason) {
        result.skipped.push({ id: row.id, reason: skipReason });
      } else {
        result.skipped.push({ id: row.id, reason: 'no_op' });
      }
    }

    if (terminalTransitions.length > 0) {
      await triggerTerminalDispatch(terminalTransitions);
    }

    return c.json(result);
  },
);

// POST /api/issues/:id/enrich
// Enqueues a custom job to re-run AI enrichment for the issue. The desktop
// device-runner picks the job off the queue. We do not run the LLM in-process.
issueExtrasRoutes.post(
  '/:id/enrich',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    // ISS-101 — enrich jobs run alongside the issue pipeline; attach to its open run.
    const run = await openIssueRun({ projectId: issue.projectId, issueId: issue.id });

    let job: { id: string; status: string } | undefined;
    try {
      const [row] = await db
        .insert(jobs)
        .values({
          projectId: issue.projectId,
          issueId: issue.id,
          pipelineRunId: run.id,
          createdBy: userId,
          type: 'custom',
          payload: { kind: 'enrich', issueId: issue.id },
          status: 'queued',
        })
        .returning({ id: jobs.id, status: jobs.status });
      job = row;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HTTPException(409, {
          message: 'enrich already queued for this issue',
          cause: { code: 'ENRICH_ALREADY_QUEUED' },
        });
      }
      throw err;
    }
    if (!job) throw new Error('jobs: insert returned no row');

    try {
      await enqueueJob(job.id);
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'enrich: enqueueJob failed; row persisted');
    }

    return c.json({ issueId: issue.id, jobId: job.id, status: job.status }, 202);
  },
);

// PATCH /api/issues/:id/manual-hold
// ISS-42 C1 — toggle the manual_hold flag. When true, the dispatcher's
// Layer-1 short-circuits with skip-reason 'manual_hold' so no new automation
// jobs spawn. In-flight jobs are not killed (acceptable race per plan).
issueExtrasRoutes.patch(
  '/:id/manual-hold',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', manualHoldBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const { value } = c.req.valid('json');
    const userId = c.get('userId');

    const [issue] = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        manualHold: issues.manualHold,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const before = issue.manualHold;
    const actor = { type: 'user' as const, id: userId };

    if (before !== value) {
      await db.transaction(async (tx) => {
        await tx
          .update(issues)
          .set({ manualHold: value, updatedAt: new Date() })
          .where(eq(issues.id, issueId));
        await recordActivityTx(tx, {
          issueId,
          actor,
          action: value ? 'issue.manualHold.set' : 'issue.manualHold.cleared',
          payload: { manualHold: value },
        });
      });

      await hooks.emit('issueUpdated', {
        issueId,
        projectId: issue.projectId,
        actor,
        fields: ['manualHold'],
        before: { manualHold: before },
        after: { manualHold: value },
      });
    }

    return c.json({ issueId, manualHold: value });
  },
);

// POST /api/issues/:id/run-pipeline-step
// ISS-5: manual trigger for a pipeline stage. Bypasses the per-stage `auto*`
// toggles so the user can re-fire forge-plan / forge-code / etc. without
// bouncing the issue status. Body `{ stage? }` overrides the default stage
// resolved from the issue's current status (STATUS_TO_SKILL).
issueExtrasRoutes.post(
  '/:id/run-pipeline-step',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', runPipelineStepBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const { stage } = c.req.valid('json');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ id: issues.id, projectId: issues.projectId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    try {
      const result = await triggerPipelineStepManual({
        projectId: issue.projectId,
        issueId: issue.id,
        status: issue.status,
        ...(stage ? { stage } : {}),
        actor: { type: 'user', id: userId },
        reason: { manual: true },
      });
      return c.json(
        { issueId: issue.id, jobId: result.jobId, stage: result.type, status: 'queued' },
        202,
      );
    } catch (err) {
      if (err instanceof ActiveJobConflictError) {
        throw new HTTPException(409, {
          message: `active ${err.type} job already running for this issue`,
          cause: {
            code: 'JOB_ALREADY_ACTIVE',
            existingJobId: err.existingJobId,
            type: err.type,
          },
        });
      }
      if (err instanceof Error && err.message === 'no skill mapped for this status') {
        throw badRequest({
          message: `cannot run pipeline for status ${issue.status} without explicit stage`,
        });
      }
      if (err instanceof SkillNotLoadableError) {
        throw new HTTPException(409, {
          message: `skill ${err.skillName} is not loadable: ${err.reason}`,
          cause: {
            code: 'SKILL_NOT_LOADABLE',
            skillName: err.skillName,
            reason: err.reason,
            expectedPath: err.expectedPath,
          },
        });
      }
      throw err;
    }
  },
);

// GET /api/issues/pipeline-timing?projectId=...&from=...&to=...
// Aggregates dwell time per status from activity_log status-change events.
// For each issue, sorts transitions by time and computes (next.at - current.at)
// as the dwell time of `current.from` status. Returns avg/median/p90 per status.
issueExtrasRoutes.get(
  '/pipeline-timing',
  zValidator('query', pipelineTimingQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, from, to, limit } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const conditions = [
      eq(issues.projectId, projectId),
      eq(activityLog.action, 'issue.statusChanged'),
    ];
    if (from) conditions.push(gte(activityLog.createdAt, from));
    if (to) conditions.push(lte(activityLog.createdAt, to));

    const rows = await db
      .select({
        issueId: activityLog.issueId,
        payload: activityLog.payload,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .innerJoin(issues, eq(issues.id, activityLog.issueId))
      .where(and(...conditions))
      .orderBy(asc(activityLog.issueId), asc(activityLog.createdAt))
      .limit(limit);

    type Row = (typeof rows)[number];
    const perStatus = new Map<string, number[]>();

    let cursor = 0;
    while (cursor < rows.length) {
      const issueId = rows[cursor]!.issueId;
      const group: Row[] = [];
      while (cursor < rows.length && rows[cursor]!.issueId === issueId) {
        group.push(rows[cursor]!);
        cursor++;
      }
      for (let i = 0; i < group.length - 1; i++) {
        const cur = group[i]!;
        const next = group[i + 1]!;
        const status = (cur.payload as { from?: string } | null)?.from;
        if (!status) continue;
        const ms = next.createdAt.getTime() - cur.createdAt.getTime();
        if (ms < 0) continue;
        let bucket = perStatus.get(status);
        if (!bucket) {
          bucket = [];
          perStatus.set(status, bucket);
        }
        bucket.push(ms);
      }
    }

    const stats = [...perStatus.entries()].map(([status, samples]) => {
      samples.sort((a, b) => a - b);
      const sum = samples.reduce((s, v) => s + v, 0);
      const avg = samples.length === 0 ? 0 : sum / samples.length;
      const median = samples.length === 0 ? 0 : samples[Math.floor(samples.length / 2)] ?? 0;
      const p90Index = Math.min(samples.length - 1, Math.floor(samples.length * 0.9));
      const p90 = samples.length === 0 ? 0 : samples[p90Index] ?? 0;
      return {
        status,
        sampleCount: samples.length,
        avgMs: Math.round(avg),
        medianMs: median,
        p90Ms: p90,
      };
    });

    stats.sort((a, b) => a.status.localeCompare(b.status));

    return c.json({ projectId, stats });
  },
);

// GET /api/issues/:id/cost-summary
// Joins usage_records.session_id ↔ jobs.id to roll up estimated cost +
// token totals for any usage row tagged with one of this issue's job ids.
issueExtrasRoutes.get(
  '/:id/cost-summary',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const [totals] = await db
      .select({
        estimatedCost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
        inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
        outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
        cacheReadTokens:
          sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)`.mapWith(Number),
        cacheCreationTokens:
          sql<number>`coalesce(sum(${usageRecords.cacheCreationTokens}), 0)`.mapWith(Number),
        requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
        sampleCount: sql<number>`count(${usageRecords.id})`.mapWith(Number),
      })
      .from(usageRecords)
      .innerJoin(jobs, eq(jobs.id, sql`${usageRecords.sessionId}::uuid`))
      .where(eq(jobs.issueId, issueId));

    return c.json({
      issueId,
      projectId: issue.projectId,
      ...(totals ?? {
        estimatedCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requests: 0,
        sampleCount: 0,
      }),
    });
  },
);
