import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
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
import { enqueueJob } from '../jobs/enqueue.js';
import { assertProjectRole, loadProjectAccess, projectRoleAtLeast } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { ActiveJobConflictError, triggerPipelineStepManual } from '../pipeline/orchestrator.js';
import { openIssueRun } from '../pipeline/runs.js';
import {
  EMPTY_USAGE_TOTALS,
  usageSessionMatch,
  usageTotalsSelection,
} from '../usage-records/rollup.js';
import {
  TransitionError,
  type TransitionErrorCode,
  transitionIssueStatus,
} from './apply-transition.js';
import { triggerTerminalDispatch } from './transition.js';

const idParamSchema = z.object({ id: z.uuid() });

// cm:guard the body takes NO `stage`. It used to name one rung of the staged ladder, and ISS-897 left one job type — accepting the field and ignoring it (which is what `dispatchDriveManual` did for the whole of 2026-09-02) is an API that reports success for a request it did not honour.
const runPipelineStepBodySchema = z.object({}).strict();

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

// cm:guard `satisfies Record<TransitionErrorCode, string>` is what makes a new transition code a COMPILE error here rather than a runtime `undefined` reason on a skipped issue — and the union below is DERIVED from this map on purpose: it used to restate all eight snake_case names, so the two could disagree and only the map was checked
const BATCH_SKIP_BY_CODE = {
  NO_OP: 'no_op',
  ILLEGAL_TRANSITION: 'illegal_transition',
  TRANSITION_REASON_REQUIRED: 'transition_reason_required',
  WAITING_KIND_REQUIRED: 'waiting_kind_required',
  STALE_TRANSITION: 'stale',
  PLAN_REQUIRED: 'plan_required',
  NO_WORK_EVIDENCE: 'no_work_evidence',
  RELEASE_RECORD_REQUIRED: 'release_record_required',
} as const satisfies Record<TransitionErrorCode, string>;

type BatchSkipReason = 'forbidden' | 'not_found' | (typeof BATCH_SKIP_BY_CODE)[TransitionErrorCode];

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
// Each field uses the per-issue mutation path (transition / plain patch) so
// activity + WS semantics match the single-issue routes.
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
    const actor = restActor(c);

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
            // Batch patch mutates issues — viewer (read-only) is not allowed.
            { allowed: projectRoleAtLeast(access.role, 'member') },
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

    // cm:why collected across the whole batch and fanned out ONCE at the end — the children read is a single inArray, so the cost stays flat in N rather than one query per transitioned issue
    // cm:guard derive this from the fan-out's own parameter type, never restate it — a local copy is how the batch path silently stops carrying a field the single-issue path added
    const terminalTransitions: Parameters<typeof triggerTerminalDispatch>[0] = [];

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
          try {
            // Same core as single-issue `/transition` — guard semantics,
            // conditional UPDATE, merged_at stamp, WS publish and run close
            // are shared. No `override` in batch — bulk bar has no UI for
            // owner-bypass. Terminal fan-out is collected below so the
            // Layer-2 dispatch tick fires once per request, not per issue.
            const transitioned = await transitionIssueStatus(
              {
                id: row.id,
                projectId: row.projectId,
                status: fromStatus,
                reopenCount: row.reopenCount,
              },
              toStatus,
              actor,
            );
            touched = true;
            row.status = toStatus;
            row.reopenCount = transitioned.reopenCount;
            if (transitioned.terminal) {
              terminalTransitions.push({
                issueId: row.id,
                projectId: row.projectId,
                issSeq: row.issSeq,
                at: transitioned.updatedAt,
                ...(toStatus === 'dropped' ? { dependents: transitioned.unblockedDependents } : {}),
              });
            }
          } catch (err) {
            if (!(err instanceof TransitionError)) throw err;
            // Single-issue `/transition` 409s/422s on these. The batch
            // surfaces them via skipReason instead so callers can see that
            // the status request was rejected even when other fields
            // succeeded.
            skipReason = BATCH_SKIP_BY_CODE[err.code];
          }
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
        // (priority/category) succeeded. Surface it on the updated
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
    assertProjectRole(access, 'member');

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
      await enqueueJob({ jobId: job.id, issueId: issue.id, type: 'custom' });
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'enrich: enqueueJob failed; row persisted');
    }

    return c.json({ issueId: issue.id, jobId: job.id, status: job.status }, 202);
  },
);

// cm:guard this endpoint is the ONLY way out of a gated entry stage, so it must keep bypassing `states.open.mode === 'manual'` — that gate says "a human decides", and this IS the human deciding. Refusing here would make the gate a dead end with no exit but editing the config.
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
    const userId = c.get('userId');

    const [issue] = await db
      .select({ id: issues.id, projectId: issues.projectId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    assertProjectRole(access, 'member');

    try {
      const result = await triggerPipelineStepManual({
        projectId: issue.projectId,
        issueId: issue.id,
        status: issue.status,
        actor: restActor(c),
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
      if (err instanceof Error && err.message.startsWith('AUTONOMOUS_NOT_AT_ENTRY')) {
        throw new HTTPException(409, {
          message: err.message,
          cause: { code: 'NOT_AT_ENTRY_STATUS', status: issue.status },
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
    if (!access.role) throw forbidden('not a project member');

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
      const issueId = rows[cursor]?.issueId;
      const group: Row[] = [];
      while (cursor < rows.length && rows[cursor]?.issueId === issueId) {
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
      const median = samples.length === 0 ? 0 : (samples[Math.floor(samples.length / 2)] ?? 0);
      const p90Index = Math.min(samples.length - 1, Math.floor(samples.length * 0.9));
      const p90 = samples.length === 0 ? 0 : (samples[p90Index] ?? 0);
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
// Rolls up estimated cost + token totals for every usage row produced while
// working this issue. usage_records.session_id is the AGENT SESSION id (not the
// job id), so the link is: usage_records.session_id = agent_sessions.id, and a
// session belongs to an issue via jobs.agent_session_id → jobs.issue_id. We
// resolve the issue's DISTINCT session ids first and sum usage over them — a
// direct usage⋈agent_sessions⋈jobs join fans out (one session can back several
// jobs) and multiplied the cost. Fixes ISS-308 B4 (cost showed "—" everywhere
// because the old `session_id::uuid = jobs.id` join never matched).
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
    if (!access.role) throw forbidden('not a project member');

    // DISTINCT agent-session ids that worked this issue (via its jobs).
    const sessionIdSubquery = sql`(
      SELECT DISTINCT ${jobs.agentSessionId}
      FROM ${jobs}
      WHERE ${jobs.issueId} = ${issueId}
        AND ${jobs.agentSessionId} IS NOT NULL
    )`;
    const [totals] = await db
      .select(usageTotalsSelection())
      .from(usageRecords)
      .where(usageSessionMatch(sql`IN ${sessionIdSubquery}`));

    return c.json({
      issueId,
      projectId: issue.projectId,
      ...(totals ?? EMPTY_USAGE_TOTALS),
    });
  },
);
