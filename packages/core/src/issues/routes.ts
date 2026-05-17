import { zValidator } from '@hono/zod-validator';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { registerIssueCommentRoutes } from '../comments/routes.js';
import { registerIssueAttachmentRoutes } from './attachment-routes.js';
import {
  AttachmentError,
  type AttachmentErrorEntry,
  type DecodedAttachment,
  type PersistedIssueAttachment,
  decodeAndValidateAttachments,
  persistDecodedIssueAttachments,
} from './attachment-service.js';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  issueComplexities,
  issueLabels,
  issuePriorities,
  issueStatuses,
  issues,
  labels,
  projectMembers,
} from '../db/schema.js';
import { paginationSchema, setTotalCount } from '../lib/pagination.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { recordActivityTx } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { hydrateAgentSessionsForIssues } from './agent-sessions-hydrator.js';
import {
  type PipelineHealth,
  hydratePipelineHealthForIssues,
} from './pipeline-health.js';
import { logger } from '../logger.js';

// Defence against partial drizzle mocks in unit tests + transient DB blips:
// pipelineHealth is derived; the list/single endpoints must not 500 if the
// derivation throws. Callers degrade to `{ stage: row.status }` per issue.
async function safeHydratePipelineHealth(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, PipelineHealth>> {
  try {
    return await hydratePipelineHealthForIssues(projectId, issueIds);
  } catch (err) {
    logger.warn(
      { err, projectId, issueCount: issueIds.length },
      'pipeline-health: hydrate failed; falling back to stage-only',
    );
    return new Map();
  }
}
import type { IssueBranchOverride } from '../branches/resolve.js';
import {
  DecomposeError,
  IntegrationBranchError,
  decomposeParent,
} from './decompose.js';
import { buildIssueOrderBy, issueSortValues } from './sort.js';

const attachmentInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(255),
    dataBase64: z.string().min(1),
  })
  .strict();

import { issueMetadataSchema, isSelfReferentialBranch } from './metadata.js';
export {
  branchNameSchema,
  branchConfigOverrideSchema,
  issueMetadataSchema,
  isSelfReferentialBranch,
} from './metadata.js';

export const issueCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).nullable().optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
    reportedBy: z.string().trim().min(1).max(200).nullable().optional(),
    assigneeId: z.uuid().nullable().optional(),
    parentIssueId: z.uuid().nullable().optional(),
    labels: z.array(z.uuid()).max(100).optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional(),
    // ISS-130 — narrow allow-list for entry status. The F4 transition
    // endpoint still owns post-creation status changes; this only exists so
    // decomposition children can land at `on_hold` (parked, no auto-triage)
    // atomically with the insert.
    status: z.enum(['open', 'on_hold']).optional(),
  })
  .strict();

export type IssueCreateInput = z.infer<typeof issueCreateSchema>;

// ISS-130 — `status` is accepted at create only for the narrow allow-list
// {open, on_hold}; all post-creation status changes still go through the F4
// transition endpoint (state-machine guard + activity entry).
// manualHold is NOT accepted here either — see PATCH /:id/manual-hold so the
// toggle has its own activity entry + WS event.
export const issuePatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(100_000).nullable().optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
    plan: z.string().max(200_000).nullable().optional(),
    acceptanceCriteria: z.string().max(100_000).nullable().optional(),
    suggestedSolution: z.string().max(100_000).nullable().optional(),
    assigneeId: z.uuid().nullable().optional(),
    labels: z.array(z.uuid()).max(100).optional(),
    metadata: issueMetadataSchema.optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

export type IssuePatchInput = z.infer<typeof issuePatchSchema>;

export const issueFiltersSchema = paginationSchema.extend({
  status: z.enum(issueStatuses).optional(),
  priority: z.enum(issuePriorities).optional(),
  assigneeId: z.uuid().optional(),
  category: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(issueSortValues).optional().default('createdAt:desc'),
  // ISS-128 — opt-in hydration of `agentSessions[]` + derived `agentStatus`.
  // Off by default so existing callers don't pay the extra query.
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

type IssueRow = {
  id: string;
  projectId: string;
  issSeq: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  category: string | null;
  reportedBy: string | null;
  complexity: string | null;
  manualHold: boolean;
  plan: string | null;
  acceptanceCriteria: string | null;
  suggestedSolution: string | null;
  aiSummary: string | null;
  aiSuggestedSolution: string | null;
  aiAcceptanceCriteria: string[] | null;
  aiConfidence: number | null;
  assigneeId: string | null;
  createdById: string;
  parentIssueId: string | null;
  metadata: ({ branchConfig?: IssueBranchOverride | null } & Record<string, unknown>) | null;
  createdAt: Date;
  updatedAt: Date;
};

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

async function assertLabelsInProject(
  projectId: string,
  labelIds: readonly string[],
): Promise<void> {
  if (labelIds.length === 0) return;
  const rows = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.projectId, projectId), inArray(labels.id, [...labelIds])));
  if (rows.length !== new Set(labelIds).size) {
    throw new HTTPException(400, {
      message: 'one or more labels do not belong to this project',
      cause: { code: 'INVALID_LABELS' },
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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    if (input.assigneeId) await assertAssigneeIsMember(projectId, input.assigneeId);
    if (input.labels && input.labels.length > 0)
      await assertLabelsInProject(projectId, input.labels);

    // Decode + size-cap attachments BEFORE opening the transaction so a bad
    // payload doesn't leave a half-created issue with no files.
    let decodedAttachments: DecodedAttachment[] = [];
    if (input.attachments && input.attachments.length > 0) {
      try {
        decodedAttachments = decodeAndValidateAttachments(input.attachments);
      } catch (err) {
        if (err instanceof AttachmentError) {
          throw new HTTPException(400, {
            message: err.message,
            cause: { code: err.code },
          });
        }
        throw err;
      }
    }

    const created = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(issues)
        .values({
          projectId,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? 'open',
          priority: input.priority ?? 'medium',
          category: input.category ?? null,
          complexity: input.complexity ?? null,
          reportedBy: input.reportedBy ?? null,
          assigneeId: input.assigneeId ?? null,
          parentIssueId: input.parentIssueId ?? null,
          createdById: userId,
        })
        .returning();
      if (!inserted) throw new Error('issues: insert returned no row');

      if (input.labels && input.labels.length > 0) {
        await tx
          .insert(issueLabels)
          .values(input.labels.map((labelId) => ({ issueId: inserted.id, labelId })));
      }

      return inserted as IssueRow;
    });

    let attachmentsResult: {
      persisted: PersistedIssueAttachment[];
      errors: AttachmentErrorEntry[];
    } = { persisted: [], errors: [] };
    if (decodedAttachments.length > 0) {
      attachmentsResult = await persistDecodedIssueAttachments(
        created.id,
        decodedAttachments,
        userId,
      );
    }

    await hooks.emit('issueCreated', {
      issueId: created.id,
      projectId: created.projectId,
      actor: { type: 'user', id: userId },
      status: created.status as IssueStatus,
      snapshot: {
        title: created.title,
        description: created.description,
        priority: created.priority,
        category: created.category,
        reportedBy: created.reportedBy,
        assigneeId: created.assigneeId,
        labels: input.labels ?? [],
      },
    });

    const response: Record<string, unknown> = serializeIssue(created);
    response.attachments = attachmentsResult.persisted;
    if (attachmentsResult.errors.length > 0) {
      response.attachmentErrors = attachmentsResult.errors;
    }
    return c.json(response, 201);
  },
);

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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const issSeq = Number(displayId.slice(4));
    const [row] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, issSeq)))
      .limit(1);
    if (!row) throw notFound('issue not found');

    const issue = row as IssueRow;

    const labelRows = await db
      .select({ id: labels.id, name: labels.name, color: labels.color })
      .from(issueLabels)
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(eq(issueLabels.issueId, issue.id));

    const serialized = serializeIssue(issue);
    const healthMap = await safeHydratePipelineHealth(projectId, [issue.id]);
    return c.json({
      ...serialized,
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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

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

    setTotalCount(c, Number(n));

    const serialized = rows.map((r) => serializeIssue(r as IssueRow));
    if (serialized.length === 0) {
      return c.json(serialized);
    }

    // ISS-164 — always hydrate pipelineHealth on the list payload. Cheap
    // (6 queries flat regardless of page size) and the FE wants it on every
    // row to render gate-aware badges.
    const ids = serialized.map((r) => r.id);
    const healthMap = await safeHydratePipelineHealth(projectId, ids);

    if (!q.withAgentSessions) {
      return c.json(
        serialized.map((r) => ({
          ...r,
          pipelineHealth: healthMap.get(r.id) ?? { stage: r.status },
        })),
      );
    }

    const map = await hydrateAgentSessionsForIssues(projectId, ids);
    return c.json(
      serialized.map((r) => {
        const bucket = map.get(r.id);
        return {
          ...r,
          agentSessions: bucket?.agentSessions ?? [],
          agentStatus: bucket?.agentStatus ?? null,
          pipelineHealth: healthMap.get(r.id) ?? { stage: r.status },
        };
      }),
    );
  },
);

export const issueRoutes = new Hono<{ Variables: AuthVars }>();
issueRoutes.use('*', requireAuth(), assertEmailVerified());

registerIssueCommentRoutes(issueRoutes);
registerIssueAttachmentRoutes(issueRoutes);

async function loadIssue(issueId: string): Promise<IssueRow> {
  const [row] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
  if (!row) throw notFound('issue not found');
  return row as IssueRow;
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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const labelRows = await db
      .select({ id: labels.id, name: labels.name, color: labels.color })
      .from(issueLabels)
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(eq(issueLabels.issueId, id));

    const healthMap = await safeHydratePipelineHealth(issue.projectId, [issue.id]);
    const serialized = serializeIssue(issue);
    return c.json({
      ...serialized,
      pipelineHealth: healthMap.get(issue.id) ?? { stage: serialized.status },
      labels: labelRows,
      comments: [],
      activity: [],
    });
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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    if (patch.assigneeId) await assertAssigneeIsMember(issue.projectId, patch.assigneeId);
    if (patch.labels && patch.labels.length > 0)
      await assertLabelsInProject(issue.projectId, patch.labels);

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
    if (patch.title !== undefined) {
      updates.title = patch.title;
      track('title', patch.title);
    }
    if (patch.description !== undefined) {
      updates.description = patch.description;
      track('description', patch.description);
    }
    if (patch.priority !== undefined) {
      updates.priority = patch.priority;
      track('priority', patch.priority);
    }
    if (patch.category !== undefined) {
      updates.category = patch.category;
      track('category', patch.category);
    }
    if (patch.complexity !== undefined) {
      updates.complexity = patch.complexity;
      track('complexity', patch.complexity);
    }
    if (patch.plan !== undefined) {
      updates.plan = patch.plan;
      track('plan', patch.plan);
    }
    if (patch.acceptanceCriteria !== undefined) {
      updates.acceptanceCriteria = patch.acceptanceCriteria;
      track('acceptanceCriteria', patch.acceptanceCriteria);
    }
    if (patch.suggestedSolution !== undefined) {
      updates.suggestedSolution = patch.suggestedSolution;
      track('suggestedSolution', patch.suggestedSolution);
    }
    if (patch.assigneeId !== undefined) {
      updates.assigneeId = patch.assigneeId;
      track('assigneeId', patch.assigneeId);
    }
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

    const actor = { type: 'user' as const, id: userId };

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(issues).set(updates).where(eq(issues.id, id)).returning();
      if (!row) throw notFound('issue not found');

      // Label add/remove activity is emitted INSIDE the transaction so it
      // rolls back with the label delta on failure. Non-label activity is
      // emitted post-commit via the hooks bus (see after this block).
      if (patch.labels !== undefined) {
        const existing = await tx
          .select({ labelId: issueLabels.labelId })
          .from(issueLabels)
          .where(eq(issueLabels.issueId, id));
        const oldSet = new Set(existing.map((r) => r.labelId));
        const newSet = new Set(patch.labels);
        const labelsAdded = [...newSet].filter((l) => !oldSet.has(l));
        const labelsRemoved = [...oldSet].filter((l) => !newSet.has(l));

        await tx.delete(issueLabels).where(eq(issueLabels.issueId, id));
        if (patch.labels.length > 0) {
          await tx
            .insert(issueLabels)
            .values(patch.labels.map((labelId) => ({ issueId: id, labelId })));
        }

        for (const labelId of labelsAdded) {
          await recordActivityTx(tx, {
            issueId: id,
            actor,
            action: 'issue.labeled',
            payload: { labelId },
          });
        }
        for (const labelId of labelsRemoved) {
          await recordActivityTx(tx, {
            issueId: id,
            actor,
            action: 'issue.unlabeled',
            payload: { labelId },
          });
        }
      }

      return row as IssueRow;
    });

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

    return c.json(serializeIssue(updated));
  },
);

// ISS-138 (PR-D) — POST /api/issues/:id/decompose
//
// Creates N children, wires `decomposes` edges, and (unless opted out)
// creates a shared integration branch on the project's git remote. All
// done atomically via `decomposeParent`. Children land at `on_hold` so the
// existing ISS-130 cascade-approve hook flips them to `approved` when the
// parent moves `waiting → approved`.
const decomposeChildNewSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).nullable().optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();

const decomposeChildExistingSchema = z
  .object({
    existingIssueId: z.uuid(),
  })
  .strict();

const decomposeBodySchema = z
  .object({
    children: z
      .array(z.union([decomposeChildNewSchema, decomposeChildExistingSchema]))
      .min(1)
      .max(8),
    useIntegrationBranch: z.boolean().optional(),
  })
  .strict();

issueRoutes.post(
  '/:id/decompose',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', decomposeBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    try {
      const result = await decomposeParent(
        id,
        body.children,
        { userId },
        { useIntegrationBranch: body.useIntegrationBranch },
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof IntegrationBranchError) {
        throw new HTTPException(502, {
          message: 'integration branch operation failed',
          cause: { code: err.code, message: err.message },
        });
      }
      if (err instanceof DecomposeError) {
        if (err.code === 'NOT_FOUND') throw notFound(err.message);
        if (err.code === 'BAD_REQUEST') {
          throw new HTTPException(400, {
            message: err.message,
            cause: { code: 'BAD_REQUEST', details: err.message },
          });
        }
        if (err.code === 'INTEGRATION_BRANCH_CONFLICT') {
          throw new HTTPException(409, {
            message: err.message,
            cause: { code: err.code },
          });
        }
        throw new HTTPException(500, {
          message: err.message,
          cause: { code: err.code },
        });
      }
      throw err;
    }
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
    if (access.ownerId !== userId && access.role !== 'owner') {
      throw forbidden('not a project owner');
    }

    await db.delete(issues).where(eq(issues.id, id));
    return c.body(null, 204);
  },
);
