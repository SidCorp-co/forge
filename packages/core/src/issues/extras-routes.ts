import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import { activityLog, type IssueStatus, issues, jobs, usageRecords } from '../db/schema.js';
import { noPromptMessage, POOL_JOB_NO_PROMPT } from '../jobs/pool-served.js';
import { assertProjectRole, loadProjectAccess, projectRoleAtLeast } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { schemaRefused } from '../lib/zod-sentences.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { NoMasterRunningError, triggerPipelineStepManual } from '../pipeline/orchestrator.js';
import {
  EMPTY_USAGE_TOTALS,
  usageSessionMatch,
  usageTotalsSelection,
} from '../usage-records/rollup.js';
import { TransitionError, transitionIssueStatus } from './apply-transition.js';
import { BATCH_SKIP_BY_CODE, type BatchSkipReason } from './batch-skip-reason.js';
import type { TransitionRewrite } from './close-substitution.js';
import {
  type BatchResult,
  batchPatchBodySchema,
  batchResultSchema,
  costSummarySchema,
  enrichIssue,
  patchIssuesBatch,
  pipelineTimingQuerySchema,
  pipelineTimingSchema,
  readCostSummary,
  readPipelineTiming,
  runPipelineStep,
  runPipelineStepAnswerSchema,
} from './extras-routes-reference.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import {
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from './issue-route-ref.js';
import { triggerTerminalDispatch } from './transition.js';

const idParamSchema = z.object({ id: z.uuid() });

const runPipelineStepBodySchema = z.object({}).strict();

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const noEnrichPrompt = () =>
  new HTTPException(422, {
    message: noPromptMessage('custom'),
    cause: { code: POOL_JOB_NO_PROMPT, lane: 'enrich' },
  });

type BatchRow = {
  id: string;
  issSeq: number;
  projectId: string;
  status: string;
  priority: string;
  category: string | null;
  reopenCount: number;
};
type TerminalTransition = Parameters<typeof triggerTerminalDispatch>[0][number];
type BatchRowOutcome =
  | {
      kind: 'skipped';
      reason: BatchSkipReason;
      detail?: string;
      refusal?: { code: TransitionError['code']; message: string };
    }
  | { kind: 'updated'; rewritten: TransitionRewrite | null; terminal: TerminalTransition | null };

const NOTHING_ELSE_WRITTEN =
  'The status move was refused, so nothing else this update carried was written for this issue: send it again without `status` to write the rest.';

/** One issue of a batch. Its priority and category are written inside its status move's own
 *  transaction, so a move the state machine refuses leaves the issue exactly as it was. */
async function patchBatchRow(
  row: BatchRow,
  data: z.infer<typeof batchPatchBodySchema>['data'],
  actor: ReturnType<typeof restActor>,
): Promise<BatchRowOutcome> {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, next, current] of [
    ['priority', data.priority, row.priority],
    ['category', data.category, row.category],
  ] as const) {
    if (next === undefined || next === current) continue;
    before[key] = current;
    after[key] = next;
  }
  const fields = Object.keys(after) as Array<'priority' | 'category'>;
  const set = { ...after, updatedAt: sql`now()` };

  let rewritten: TransitionRewrite | null = null;
  let terminal: TerminalTransition | null = null;
  if (data.status === undefined) {
    if (fields.length === 0) return { kind: 'skipped', reason: 'no_op' };
    await db.update(issues).set(set).where(eq(issues.id, row.id));
  } else {
    const toStatus = data.status;
    try {
      const moved = await transitionIssueStatus(
        {
          id: row.id,
          projectId: row.projectId,
          status: row.status as IssueStatus,
          reopenCount: row.reopenCount,
        },
        toStatus,
        actor,
        {
          reason: data.reason || undefined,
          transitionReason: data.reason || undefined,
          beforeStatusWrite: async (tx) => {
            if (fields.length > 0) await tx.update(issues).set(set).where(eq(issues.id, row.id));
          },
        },
      );
      rewritten = moved.rewritten;
      if (moved.terminal) {
        terminal = {
          issueId: row.id,
          projectId: row.projectId,
          issSeq: row.issSeq,
          at: moved.updatedAt,
          ...(toStatus === 'dropped' ? { dependents: moved.unblockedDependents } : {}),
        };
      }
    } catch (err) {
      if (!(err instanceof TransitionError)) throw err;
      // The same code and sentence every other door answers this refusal with (ISS-1421 round 2).
      const refusal = { code: err.code, message: err.detail };
      return fields.length > 0
        ? {
            kind: 'skipped',
            reason: BATCH_SKIP_BY_CODE[err.code],
            detail: NOTHING_ELSE_WRITTEN,
            refusal,
          }
        : { kind: 'skipped', reason: BATCH_SKIP_BY_CODE[err.code], refusal };
    }
  }
  if (fields.length > 0) {
    await hooks.emit('issueUpdated', {
      issueId: row.id,
      projectId: row.projectId,
      actor,
      fields,
      before,
      after,
    });
  }
  return { kind: 'updated', rewritten, terminal };
}

export const issueExtrasRoutes = new Hono<{ Variables: AuthVars }>();
issueExtrasRoutes.use('*', requireAuth(), assertEmailVerified());

issueExtrasRoutes.patch(
  '/batch',
  patchIssuesBatch,
  zValidator('json', batchPatchBodySchema, (r) => {
    if (!r.success) throw schemaRefused(r.error, batchPatchBodySchema, r.data);
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

    const distinctProjects = [...new Set(rows.map((r) => r.projectId))];
    type ProjectAccessState = { allowed: boolean; missing?: boolean };
    const accessMap = new Map<string, ProjectAccessState>();
    const accessResolutions = await Promise.all(
      distinctProjects.map(async (projectId): Promise<[string, ProjectAccessState]> => {
        try {
          const access = await loadProjectAccess(projectId, userId);
          return [projectId, { allowed: projectRoleAtLeast(access.role, 'member') }];
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

      let outcome: BatchRowOutcome;
      try {
        outcome = await patchBatchRow(row, data, actor);
      } catch (err) {
        result.failed.push({
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (outcome.kind === 'skipped') {
        const { reason, detail, refusal } = outcome;
        result.skipped.push({
          id: row.id,
          reason,
          ...(refusal ?? {}),
          ...(detail ? { detail } : {}),
        });
        continue;
      }
      if (outcome.terminal) terminalTransitions.push(outcome.terminal);
      result.updated.push({
        id: row.id,
        displayId: formatIssueRef(prefixMap.get(row.projectId) ?? null, row.issSeq),
        ...(outcome.rewritten ? { rewritten: outcome.rewritten } : {}),
      });
    }

    if (terminalTransitions.length > 0) {
      await triggerTerminalDispatch(terminalTransitions);
    }

    return c.json(answer(batchResultSchema, result));
  },
);

issueExtrasRoutes.post(
  '/:id/enrich',
  enrichIssue,
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw schemaRefused(r.error, idParamSchema, r.data);
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

    // No enrich prompt is built anywhere, and the job pool runs only the prompt a
    // job is minted with (ISS-1135).
    throw noEnrichPrompt();
  },
);

issueExtrasRoutes.post(
  '/:id/run-pipeline-step',
  runPipelineStep,
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw schemaRefused(r.error, idParamSchema, r.data);
  }),
  zValidator('json', runPipelineStepBodySchema, (r) => {
    if (!r.success) throw schemaRefused(r.error, runPipelineStepBodySchema, r.data);
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
      const done = await triggerPipelineStepManual({
        projectId: issue.projectId,
        issueId: issue.id,
        status: issue.status,
        actor: restActor(c),
        reason: { manual: true },
      });
      return c.json(
        answer(runPipelineStepAnswerSchema, { issueId: issue.id, status: issue.status, ...done }),
        202,
      );
    } catch (err) {
      if (err instanceof NoMasterRunningError) {
        throw new HTTPException(409, {
          message: err.message,
          cause: { code: 'NO_MASTER_RUNNING' satisfies typeof err.code },
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
  readPipelineTiming,
  zValidator('query', pipelineTimingQuerySchema, (r) => {
    if (!r.success) throw schemaRefused(r.error, pipelineTimingQuerySchema, r.data);
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

    return c.json(answer(pipelineTimingSchema, { projectId, stats }));
  },
);

issueExtrasRoutes.get(
  '/:id/cost-summary',
  readCostSummary,
  zValidator('param', issueRouteIdParamSchema, (r) => {
    if (!r.success) throw schemaRefused(r.error, issueRouteIdParamSchema, r.data);
  }),
  zValidator('query', projectScopeQuerySchema, (r) => {
    if (!r.success) throw schemaRefused(r.error, projectScopeQuerySchema, r.data);
  }),
  async (c) => {
    const { id: rawId } = c.req.valid('param');
    const { projectId: projectIdQuery } = c.req.valid('query');
    const userId = c.get('userId');

    const issue = await resolveIssueRouteRef(rawId, projectIdQuery, userId);
    const issueId = issue.id;

    const sessionIdSubquery = sql`(
      SELECT DISTINCT ${jobs.agentSessionId}::text
      FROM ${jobs}
      WHERE ${jobs.issueId} = ${issueId}
        AND ${jobs.agentSessionId} IS NOT NULL
    )`;
    const [totals] = await db
      .select(usageTotalsSelection())
      .from(usageRecords)
      .where(usageSessionMatch(sql`IN ${sessionIdSubquery}`));

    return c.json(
      answer(costSummarySchema, {
        issueId,
        projectId: issue.projectId,
        ...(totals ?? EMPTY_USAGE_TOTALS),
      }),
    );
  },
);
