import { zValidator } from '@hono/zod-validator';
import { and, count, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { BodyInvalidError } from '../body/errors.js';
import { BODY_FORMATS } from '../body/formats.js';
import { bodyInvalidHttp } from '../body/http-error.js';
import { registerIssueCommentRoutes } from '../comments/routes.js';
import { db } from '../db/client.js';
import {
  issueComplexities,
  issuePriorities,
  issueStatuses,
  issues,
  jobs,
  jobTypes,
  projectMembers,
  usageRecords,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { listResponse, paginationSchema } from '../lib/pagination.js';
import { logger } from '../logger.js';
import { deleteMemory } from '../memory/indexer.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { hydrateAgentSessionsForIssues } from './agent-sessions-hydrator.js';
import { AttachmentError } from './attachment-service.js';
import { createIssue, IssueCreateError } from './create-service.js';
import { hydrateCreatorsForIssues } from './creator.js';
import {
  LabelResolutionError,
  listIssueLabels,
  PrimaryModuleError,
  type ResolvedLabelAttach,
  resolveLabelIdsForWrite,
} from './label-service.js';
import { collectIssueFieldUpdates, SHARED_ISSUE_PATCH_FIELDS } from './patch-fields.js';
import { safeHydratePipelineHealthForIssues } from './pipeline-health.js';
import { findIssueByDisplaySeq, findIssueById, type IssueRow } from './read-service.js';
import { issueRelationInputSchema } from './relations-service.js';
import { sessionContextExpectSchema, sessionContextSchema } from './session-context.js';
import { buildIssueOrderBy, issueSortValues } from './sort.js';
import {
  IssueUpdateNotFound,
  SessionContextExpectMismatch,
  updateIssueFields,
} from './update-service.js';

const attachmentInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(255),
    dataBase64: z.string().min(1),
  })
  .strict();

import { isSelfReferentialBranch, issueMetadataSchema } from './metadata.js';

export {
  branchConfigOverrideSchema,
  branchNameSchema,
  isSelfReferentialBranch,
  issueMetadataSchema,
} from './metadata.js';

import { withKernelMarker } from '../db/kernel-marker.js';
import { ReleaseNotesSchema } from './release-notes.js';

// cm:guard the object arm's `labelId` accepts a NAME or a uuid, exactly as the bare string does — both arms go through `resolveLabelIdsForWrite`, so a caller can never have one value mean an id here and a name there. `isPrimary` is legal only on a `kind='module'` label; the resolver refuses the rest with PRIMARY_NOT_MODULE / MULTIPLE_PRIMARY.
const labelAttachItemSchema = z.union([
  z.string().trim().min(1),
  z
    .object({
      labelId: z.string().trim().min(1),
      isPrimary: z.boolean().optional(),
    })
    .strict(),
]);

export const issueCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).nullable().optional(),
    descriptionFormat: z.enum(BODY_FORMATS).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
    reportedBy: z.string().trim().min(1).max(200).nullable().optional(),
    assigneeId: z.uuid().nullable().optional(),
    labels: z.array(labelAttachItemSchema).max(100).optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional(),
    detectorKey: z.string().trim().min(1).max(120).optional(),
    relations: z.array(issueRelationInputSchema).max(20).optional(),
    // cm:why ISS-130 / ISS-236 — the F4 transition endpoint owns every post-creation status change; this allow-list exists only so a caller can park at `on_hold` atomically with the insert, or hold an AI-generated proposal (Dream / Doc-Sync) at `draft` until a human promotes or discards it
    status: z.enum(['open', 'on_hold', 'draft']).optional(),
  })
  .strict();

export type IssueCreateInput = z.infer<typeof issueCreateSchema>;

export const issuePatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(100_000).nullable().optional(),
    descriptionFormat: z.enum(BODY_FORMATS).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
    plan: z.string().max(200_000).nullable().optional(),
    acceptanceCriteria: z.string().max(100_000).nullable().optional(),
    assigneeId: z.uuid().nullable().optional(),
    labels: z.array(labelAttachItemSchema).max(100).optional(),
    metadata: issueMetadataSchema.optional(),
    releaseNotes: ReleaseNotesSchema.nullable().optional(),
    // cm:guard these two were MCP-only until the CLI needed them, and they are the reason `sessionContextSchema` is imported rather than re-declared: `sessionContext.branch` is what `pipeline/work-evidence.ts` reads as proof that work exists, so an agent that cannot write it here cannot satisfy the very evidence gate this surface now enforces. Widening it to REST also hands it to a browser session, which is deliberate — a person may edit it, and the ISS-820 verified-claim walk still applies to them.
    sessionContext: sessionContextSchema,
    detectorKey: z.string().trim().min(1).max(120).optional(),
    // cm:guard ISS-959 — `expect` is a PRECONDITION, not a field: it must never reach `SHARED_ISSUE_PATCH_FIELDS`, or the value a client read back would be written to a column. The refine below is what keeps it from standing alone — a compare-and-set with nothing to write is a read wearing a write's verb, and it would still bump `updated_at`.
    expect: sessionContextExpectSchema.optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' })
  .refine((o) => Object.keys(o).some((k) => k !== 'expect'), {
    message: '`expect` is a precondition on a write — send the field(s) to write alongside it',
  });

export type IssuePatchInput = z.infer<typeof issuePatchSchema>;

export const issueFiltersSchema = paginationSchema.extend({
  status: z.enum(issueStatuses).optional(),
  priority: z.enum(issuePriorities).optional(),
  assigneeId: z.uuid().optional(),
  category: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(issueSortValues).optional().default('createdAt:desc'),
  // cm:why default false rather than true: hydration is a second query per page, and the callers that want sessions are the two screens that render them
  withAgentSessions: z.coerce.boolean().optional().default(false),
});

export type IssueFilters = z.infer<typeof issueFiltersSchema>;

const projectIdParamSchema = z.object({ id: z.uuid() });
const issueIdParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

// cm:guard the CURRENT value must travel with the refusal. A bare 409 tells the loser its write failed and nothing about what to do next, so the only move left is to read again and write unconditionally — which is the overwrite this refusal exists to prevent.
const sessionContextMoved = (err: SessionContextExpectMismatch) =>
  new HTTPException(409, {
    message:
      '`sessionContext` no longer holds the value this write expected — another writer moved it. ' +
      'Re-read it from `details.current`, decide whether your claim still stands, and send the write again with the new `expect`.',
    cause: { code: 'SESSION_CONTEXT_MISMATCH', details: { current: err.current } },
  });

function serializeIssue<T extends { issSeq: number }>(row: T): T & { displayId: string } {
  return { ...row, displayId: `ISS-${row.issSeq}` };
}

async function assertAssigneeIsMember(projectId: string, assigneeId: string): Promise<void> {
  const [row] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, assigneeId)))
    .limit(1);
  if (!row) {
    throw new HTTPException(400, {
      message: 'assignee must be a project member',
      cause: { code: 'ASSIGNEE_NOT_MEMBER' },
    });
  }
}

export const issueProjectRoutes = new Hono<{ Variables: AuthVars }>();
issueProjectRoutes.use('*', requireAuth(), assertEmailVerified());

issueProjectRoutes.post(
  '/:id/issues',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', issueCreateSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'member');

    if (input.assigneeId) await assertAssigneeIsMember(projectId, input.assigneeId);

    let result: Awaited<ReturnType<typeof createIssue>>;
    try {
      result = await createIssue(
        { ...input, projectId },
        { createdById: userId, createdVia: 'web', actor: restActor(c) },
      );
    } catch (err) {
      throw toHttpCreateError(err);
    }

    // cm:why a detectorKey that already tracks a live issue is a successful no-op, not a conflict — the caller asked for "one issue per detector" and got it; 200 says nothing was created without making it an error the client must special-case as a failure
    if (result.deduped) return c.json(result, 200);

    const response: Record<string, unknown> = serializeIssue(result.issue as IssueRow);
    response.attachments = result.attachments;
    if (result.attachmentErrors.length > 0) response.attachmentErrors = result.attachmentErrors;
    if (result.relations.length > 0) response.relations = result.relations;
    if (result.bodyWarnings.length > 0) response.warnings = result.bodyWarnings;
    return c.json(response, 201);
  },
);

// cm:edge lockstep -> packages/core/src/issues/create-service.ts — every error the create service can raise needs a case here, or it surfaces as an unmapped 500
function toHttpCreateError(err: unknown): unknown {
  if (err instanceof BodyInvalidError) return bodyInvalidHttp(err);
  if (err instanceof LabelResolutionError) {
    return new HTTPException(400, {
      message: 'one or more labels do not exist in this project',
      cause: { code: 'INVALID_LABELS', details: { missing: err.missing } },
    });
  }
  if (err instanceof PrimaryModuleError) {
    return new HTTPException(400, { message: err.message, cause: { code: err.code } });
  }
  if (err instanceof AttachmentError) {
    return new HTTPException(400, { message: err.message, cause: { code: err.code } });
  }
  if (err instanceof IssueCreateError) {
    const code = err.code;
    return new HTTPException(400, { message: `${code}: ${err.value}`, cause: { code } });
  }
  return err;
}

const displayIdParamSchema = z.object({
  id: z.uuid(),
  displayId: z.string().regex(/^ISS-\d+$/i),
});

issueProjectRoutes.get(
  '/:id/issues/by-display/:displayId',
  zValidator('param', displayIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId, displayId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const issSeq = Number(displayId.slice(4));
    const issue = await findIssueByDisplaySeq(projectId, issSeq);
    if (!issue) throw notFound('issue not found');

    const labelRows = await listIssueLabels(issue.id);

    const serialized = serializeIssue(issue);
    const healthMap = await safeHydratePipelineHealthForIssues(projectId, [issue.id]);
    const creatorMap = await hydrateCreatorsForIssues([
      { id: issue.id, createdById: issue.createdById, createdVia: issue.createdVia },
    ]);
    return c.json({
      ...serialized,
      ...creatorMap.get(issue.id),
      pipelineHealth: healthMap.get(issue.id) ?? { stage: serialized.status },
      labels: labelRows,
      comments: [],
      activity: [],
    });
  },
);

issueProjectRoutes.get(
  '/:id/issues',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', issueFiltersSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const conditions = [eq(issues.projectId, projectId)];
    if (q.status) conditions.push(eq(issues.status, q.status));
    if (q.priority) conditions.push(eq(issues.priority, q.priority));
    if (q.assigneeId) conditions.push(eq(issues.assigneeId, q.assigneeId));
    if (q.category) conditions.push(eq(issues.category, q.category));
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(issues).where(where);

    const orderBy = buildIssueOrderBy(q.sort);

    const rows = await db
      .select()
      .from(issues)
      .where(where)
      .orderBy(orderBy)
      .limit(q.limit)
      .offset(q.offset);

    const total = Number(n);

    const serialized = rows.map((r) => serializeIssue(r as IssueRow));
    if (serialized.length === 0) {
      return c.json(listResponse(c, serialized, total, q));
    }

    // cm:why pipelineHealth is hydrated unconditionally here while `agentSessions` is opt-in above, and the asymmetry is measured: this is 6 queries flat regardless of page size, and every row on the list renders a gate-aware badge from it (ISS-164).
    const ids = serialized.map((r) => r.id);
    const healthMap = await safeHydratePipelineHealthForIssues(projectId, ids);
    // cm:why no opt-in flag here — every list/detail surface needs the creator fields, unlike withCost/withAgentSessions
    const creatorMap = await hydrateCreatorsForIssues(
      serialized.map((r) => ({ id: r.id, createdById: r.createdById, createdVia: r.createdVia })),
    );

    if (!q.withAgentSessions) {
      return c.json(
        listResponse(
          c,
          serialized.map((r) => ({
            ...r,
            ...creatorMap.get(r.id),
            pipelineHealth: healthMap.get(r.id) ?? { stage: r.status },
          })),
          total,
          q,
        ),
      );
    }

    const map = await hydrateAgentSessionsForIssues(projectId, ids);
    return c.json(
      listResponse(
        c,
        serialized.map((r) => {
          const bucket = map.get(r.id);
          return {
            ...r,
            ...creatorMap.get(r.id),
            agentSessions: bucket?.agentSessions ?? [],
            agentStatus: bucket?.agentStatus ?? null,
            pipelineHealth: healthMap.get(r.id) ?? { stage: r.status },
          };
        }),
        total,
        q,
      ),
    );
  },
);

export const issueRoutes = new Hono<{ Variables: AuthVars }>();
issueRoutes.use('*', requireAuth(), assertEmailVerified());

registerIssueCommentRoutes(issueRoutes);
// cm:why the issue attachment endpoints are a SEPARATE router (`issueAttachmentRoutes`, mounted at /api/issues in index.ts) rather than registered here: this router applies `requireAuth()` to everything, and those two endpoints must also accept a PAT and a device credential — mounting them here would silently narrow that to browser sessions.

async function loadIssue(issueId: string): Promise<IssueRow> {
  const row = await findIssueById(issueId);
  if (!row) throw notFound('issue not found');
  return row;
}

issueRoutes.get(
  '/:id',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const labelRows = await listIssueLabels(id);

    const healthMap = await safeHydratePipelineHealthForIssues(issue.projectId, [issue.id]);
    const serialized = serializeIssue(issue);
    // cm:guard the detail payload hydrates `agentStatus` like the list and search payloads do — without it PipelineTracker falls back to a status-only bead and an issue whose agent FAILED still draws green (ISS-308).
    const agentMap = await hydrateAgentSessionsForIssues(issue.projectId, [issue.id]);
    const agentBucket = agentMap.get(issue.id);
    const creatorMap = await hydrateCreatorsForIssues([
      { id: issue.id, createdById: issue.createdById, createdVia: issue.createdVia },
    ]);
    return c.json({
      ...serialized,
      ...creatorMap.get(issue.id),
      agentSessions: agentBucket?.agentSessions ?? [],
      agentStatus: agentBucket?.agentStatus ?? null,
      pipelineHealth: healthMap.get(issue.id) ?? { stage: serialized.status },
      labels: labelRows,
      comments: [],
      activity: [],
    });
  },
);

// W2.1.4 (ISS-202) — Inspector History tab. Returns every job of a given
// pipeline step on the issue, newest first, with token/cost rolled up from
// usage_records using the same `session_id::uuid = jobs.id` cast as
// loadActualUsage in jobs/routes.ts. LEFT JOIN keeps queued/running rows
// visible (tokens=0, cost=0). 403 contract matches GET /api/issues/:id.
const jobHistoryQuerySchema = z.object({
  step: z.enum(jobTypes),
});

issueRoutes.get(
  '/:id/job-history',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', jobHistoryQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { step } = c.req.valid('query');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const rows = await db
      .select({
        jobId: jobs.id,
        status: jobs.status,
        model: jobs.modelUsed,
        startedAt: jobs.dispatchedAt,
        finishedAt: jobs.finishedAt,
        estTokens: jobs.promptInputTokenEst,
        tokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
        cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
      })
      .from(jobs)
      .leftJoin(usageRecords, sql`${usageRecords.sessionId}::uuid = ${jobs.id}::uuid`)
      .where(and(eq(jobs.issueId, id), eq(jobs.type, step)))
      .groupBy(jobs.id)
      .orderBy(sql`coalesce(${jobs.dispatchedAt}, ${jobs.queuedAt}) desc`);

    return c.json(rows);
  },
);

issueRoutes.patch(
  '/:id',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', issuePatchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    assertProjectRole(access, 'member');

    if (patch.assigneeId) await assertAssigneeIsMember(issue.projectId, patch.assigneeId);
    // cm:guard `undefined` means "no change" and `[]` means "clear every label" — collapsing the two makes an unrelated PATCH silently wipe the issue's labels
    let resolvedLabelIds: ResolvedLabelAttach[] | undefined;
    if (patch.labels !== undefined) {
      try {
        resolvedLabelIds = await resolveLabelIdsForWrite(issue.projectId, patch.labels);
      } catch (err) {
        throw toHttpCreateError(err);
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const changedFields: string[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const track = (field: keyof IssueRow, next: unknown) => {
      const prev = issue[field];
      if (prev !== next) {
        changedFields.push(field);
        before[field] = prev;
        after[field] = next;
      }
    };
    // Plain fields via the shared whitelist (issues/patch-fields.ts) so the
    // REST and MCP update surfaces cannot drift column lists.
    let collected: ReturnType<typeof collectIssueFieldUpdates>;
    try {
      collected = collectIssueFieldUpdates(
        patch,
        [...SHARED_ISSUE_PATCH_FIELDS, 'assigneeId'],
        (f, v) => track(f as keyof IssueRow, v),
      );
    } catch (err) {
      throw toHttpCreateError(err);
    }
    Object.assign(updates, collected.updates);
    if (patch.metadata !== undefined) {
      const baseRaw = patch.metadata?.branchConfig?.baseBranch;
      if (typeof baseRaw === 'string' && isSelfReferentialBranch(baseRaw, issue.issSeq)) {
        throw new HTTPException(400, {
          message: "baseBranch must not reference this issue's own branch",
          cause: { code: 'BRANCH_SELF_REFERENCE' },
        });
      }
      updates.metadata = patch.metadata;
      track('metadata', patch.metadata);
    }

    const actor = restActor(c);

    let updated: IssueRow;
    try {
      updated = await updateIssueFields({
        issueId: id,
        updates,
        labelIds: resolvedLabelIds,
        ...(patch.expect ? { expect: patch.expect } : {}),
        actor,
      });
    } catch (err) {
      if (err instanceof IssueUpdateNotFound) throw notFound('issue not found');
      if (err instanceof SessionContextExpectMismatch) throw sessionContextMoved(err);
      throw err;
    }

    if (changedFields.length > 0) {
      await hooks.emit('issueUpdated', {
        issueId: id,
        projectId: issue.projectId,
        actor,
        fields: changedFields,
        before,
        after,
      });
    }

    const patched = serializeIssue(updated);
    return c.json(
      collected.warnings.length > 0 ? { ...patched, warnings: collected.warnings } : patched,
    );
  },
);

issueRoutes.delete(
  '/:id',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    // cm:edge contract -> packages/core/drizzle/migrations/0219_unaudited_transition_reach.sql — `pipeline_runs.issue_id` is `ON DELETE CASCADE`, so this statement deletes kernel rows and owes the `forge.kernel_txn` marker; without it every issue delete is charged to the interventions metric as a hand on the database.
    await withKernelMarker(db, async (tx) => tx.delete(issues).where(eq(issues.id, id)));

    // The issue's memory row references it only by sourceRef (no FK), so a
    // hard delete would otherwise leave the title/description searchable
    // forever. Detached: memory cleanup must not delay or fail the delete.
    queueMicrotask(() => {
      deleteMemory(issue.projectId, 'issue', id).catch((err) => {
        logger.warn(
          { err: (err as Error).message, issueId: id, projectId: issue.projectId },
          'issues.delete: memory cleanup failed',
        );
      });
    });

    return c.body(null, 204);
  },
);
