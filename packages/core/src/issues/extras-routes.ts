import { noPromptMessage, POOL_JOB_NO_PROMPT } from '@forge/contracts/jobs';
import { Hono } from 'hono';
import { z } from 'zod';
import { issuePriorities, issueStatuses } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { RefusalError } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { triggerPipelineStepManual } from '../pipeline/index.js';
import { statusChangeRows } from './activity-read.js';
import { patchIssueBatch } from './batch-patch.js';
import {
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from './issue-route-ref.js';
import { issueScopeOf, issueUsageTotals } from './read-service.js';

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

issueExtrasRoutes.patch('/batch', zValidator('json', batchPatchBodySchema), async (c) => {
  const { ids, data } = c.req.valid('json');
  return c.json(await patchIssueBatch(ids, data, c.get('userId'), restActor(c)));
});

issueExtrasRoutes.post('/:id/enrich', zValidator('param', idParamSchema), async (c) => {
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
});

issueExtrasRoutes.post(
  '/:id/run-pipeline-step',
  zValidator('param', idParamSchema),
  zValidator('json', runPipelineStepBodySchema),
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
  zValidator('query', pipelineTimingQuerySchema),
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
  zValidator('param', issueRouteIdParamSchema),
  zValidator('query', projectScopeQuerySchema),
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
