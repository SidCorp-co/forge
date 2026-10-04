import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type IssueStatus, issuePriorities, issueStatuses } from '../db/schema.js';
import { noPromptMessage, POOL_JOB_NO_PROMPT } from '../jobs/pool-served.js';
import { loadProjectAccess } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { RefusalError } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { holds, requireHeld } from '../permissions/index.js';
import { triggerPipelineStepManual } from '../pipeline/orchestrator.js';
import { statusChangeRows } from './activity-read.js';
import { TransitionError, transitionIssueStatus } from './apply-transition.js';
import { BATCH_SKIP_BY_CODE, type BatchSkipReason } from './batch-skip-reason.js';
import { applyBatchFieldEdit, type IssueTriage } from './field-writes.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import {
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from './issue-route-ref.js';
import { batchIssueRows, issueScopeOf, issueUsageTotals } from './read-service.js';
import { triggerTerminalDispatch } from './transition.js';

const runPipelineStepBodySchema = z.object({}).strict();

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

export const issueExtrasRoutes = new Hono<{ Variables: AuthVars }>();
issueExtrasRoutes.use('*', requireAuth(), assertEmailVerified());

type BatchResult = {
  updated: Array<{
    id: string;
    displayId: string;
    skipReason?: BatchSkipReason;
  }>;
  skipped: Array<{ id: string; reason: BatchSkipReason }>;
  failed: Array<{ id: string; error: string }>;
};

issueExtrasRoutes.patch(
  '/batch',
  zValidator('json', batchPatchBodySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { ids, data } = c.req.valid('json');
    const userId = c.get('userId');
    const actor = restActor(c);

    const result: BatchResult = { updated: [], skipped: [], failed: [] };

    const rows = await batchIssueRows(ids);

    const foundIds = new Set(rows.map((r) => r.id));
    for (const id of ids) {
      if (!foundIds.has(id)) result.skipped.push({ id, reason: 'not_found' });
    }

    const distinctProjects = [...new Set(rows.map((r) => r.projectId))];
    type ProjectAccessState = { allowed: boolean; missing?: boolean };
    const accessMap = new Map<string, ProjectAccessState>();
    const accessResolutions = await Promise.all(
      distinctProjects.map(async (projectId): Promise<[string, ProjectAccessState]> => {
        try {
          const access = await loadProjectAccess(projectId, userId);
          return [projectId, { allowed: holds(access, 'project.write') }];
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

    const prefixMap = new Map<string, string | null>(
      await Promise.all(
        distinctProjects.map(
          async (projectId): Promise<[string, string | null]> => [
            projectId,
            await activeIssuePrefix(projectId),
          ],
        ),
      ),
    );

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
            // Single-issue `/transition` refuses these in the envelope. The batch
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
          await applyBatchFieldEdit(row, plainUpdates as IssueTriage, {
            actor,
            fields: changedFields,
            before,
            after,
          });
          touched = true;
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
          displayId: formatIssueRef(prefixMap.get(row.projectId) ?? null, row.issSeq),
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

issueExtrasRoutes.post(
  '/:id/enrich',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const issue = await issueScopeOf(issueId);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    requireHeld(access, 'project.write');

    // No enrich prompt is built anywhere, and the job pool runs only the prompt a
    // job is minted with (ISS-1135).
    throw new RefusalError(
      [{ code: POOL_JOB_NO_PROMPT, path: '', detail: noPromptMessage('custom') }],
      POOL_JOB_NO_PROMPT,
    );
  },
);

issueExtrasRoutes.post(
  '/:id/run-pipeline-step',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', runPipelineStepBodySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const issue = await issueScopeOf(issueId);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    requireHeld(access, 'project.write', "starting an issue's pipeline");

    const { startedAt } = await triggerPipelineStepManual({
      projectId: issue.projectId,
      issueId: issue.id,
      status: issue.status,
      actor: restActor(c),
      reason: { manual: true },
    });
    return c.json({ issueId: issue.id, status: issue.status, startedAt }, 202);
  },
);

// GET /api/issues/pipeline-timing?projectId=...&from=...&to=...
// Aggregates dwell time per status from activity_log status-change events.
// For each issue, sorts transitions by time and computes (next.at - current.at)
// as the dwell time of `current.from` status. Returns avg/median/p90 per status.
issueExtrasRoutes.get(
  '/pipeline-timing',
  zValidator('query', pipelineTimingQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId, from, to, limit } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const rows = await statusChangeRows(projectId, from, to, limit);

    type Row = (typeof rows)[number];
    const perStatus = new Map<string, number[]>();

    let cursor = 0;
    while (cursor < rows.length) {
      const issueId = rows[cursor]?.issueId;
      const group: Row[] = [];
      for (
        let row = rows[cursor];
        row !== undefined && row.issueId === issueId;
        row = rows[cursor]
      ) {
        group.push(row);
        cursor++;
      }
      for (let i = 0; i < group.length - 1; i++) {
        const cur = group[i];
        const next = group[i + 1];
        if (!cur || !next) continue;
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

issueExtrasRoutes.get(
  '/:id/cost-summary',
  zValidator('param', issueRouteIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', projectScopeQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: rawId } = c.req.valid('param');
    const { projectId: projectIdQuery } = c.req.valid('query');
    const userId = c.get('userId');

    const issue = await resolveIssueRouteRef(rawId, projectIdQuery, userId);
    const issueId = issue.id;

    return c.json({
      issueId,
      projectId: issue.projectId,
      ...(await issueUsageTotals(issueId)),
    });
  },
);
