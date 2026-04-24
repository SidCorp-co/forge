import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { registerIssueCommentRoutes } from '../comments/routes.js';
import { db } from '../db/client.js';
import {
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

const issueCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).nullable().optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    assigneeId: z.uuid().nullable().optional(),
    parentIssueId: z.uuid().nullable().optional(),
    labels: z.array(z.uuid()).max(100).optional(),
  })
  .strict();

// status is NOT accepted here — F4 transition endpoint owns status changes.
const issuePatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(100_000).nullable().optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    assigneeId: z.uuid().nullable().optional(),
    labels: z.array(z.uuid()).max(100).optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const issueFiltersSchema = paginationSchema.extend({
  status: z.enum(issueStatuses).optional(),
  priority: z.enum(issuePriorities).optional(),
  assigneeId: z.uuid().optional(),
});

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
  assigneeId: string | null;
  createdById: string;
  parentIssueId: string | null;
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

    const created = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(issues)
        .values({
          projectId,
          title: input.title,
          description: input.description ?? null,
          priority: input.priority ?? 'medium',
          category: input.category ?? null,
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

      await recordActivityTx(tx, {
        issueId: inserted.id,
        actor: { type: 'user', id: userId },
        action: 'issue.created',
        payload: {
          snapshot: {
            title: inserted.title,
            description: inserted.description,
            priority: inserted.priority,
            category: inserted.category,
            assigneeId: inserted.assigneeId,
            labels: input.labels ?? [],
          },
        },
      });

      return inserted as IssueRow;
    });

    return c.json(serializeIssue(created), 201);
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
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(issues).where(where);

    const rows = await db
      .select()
      .from(issues)
      .where(where)
      .orderBy(desc(issues.createdAt))
      .limit(q.limit)
      .offset(q.offset);

    setTotalCount(c, Number(n));
    return c.json(rows.map((r) => serializeIssue(r as IssueRow)));
  },
);

export const issueRoutes = new Hono<{ Variables: AuthVars }>();
issueRoutes.use('*', requireAuth(), assertEmailVerified());

registerIssueCommentRoutes(issueRoutes);

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

    return c.json({
      ...serializeIssue(issue),
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
    if (patch.assigneeId !== undefined) {
      updates.assigneeId = patch.assigneeId;
      track('assigneeId', patch.assigneeId);
    }

    const actor = { type: 'user' as const, id: userId };

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(issues).set(updates).where(eq(issues.id, id)).returning();
      if (!row) throw notFound('issue not found');

      let labelsAdded: string[] = [];
      let labelsRemoved: string[] = [];
      if (patch.labels !== undefined) {
        const existing = await tx
          .select({ labelId: issueLabels.labelId })
          .from(issueLabels)
          .where(eq(issueLabels.issueId, id));
        const oldSet = new Set(existing.map((r) => r.labelId));
        const newSet = new Set(patch.labels);
        labelsAdded = [...newSet].filter((l) => !oldSet.has(l));
        labelsRemoved = [...oldSet].filter((l) => !newSet.has(l));

        await tx.delete(issueLabels).where(eq(issueLabels.issueId, id));
        if (patch.labels.length > 0) {
          await tx
            .insert(issueLabels)
            .values(patch.labels.map((labelId) => ({ issueId: id, labelId })));
        }
      }

      const nonLabelFields = changedFields.filter((f) => f !== 'assigneeId');
      if (nonLabelFields.length > 0) {
        const filteredBefore: Record<string, unknown> = {};
        const filteredAfter: Record<string, unknown> = {};
        for (const f of nonLabelFields) {
          filteredBefore[f] = before[f];
          filteredAfter[f] = after[f];
        }
        await recordActivityTx(tx, {
          issueId: id,
          actor,
          action: 'issue.updated',
          payload: {
            fields: nonLabelFields,
            before: filteredBefore,
            after: filteredAfter,
          },
        });
      }
      if (changedFields.includes('assigneeId')) {
        await recordActivityTx(tx, {
          issueId: id,
          actor,
          action: 'issue.assigned',
          payload: { before: before.assigneeId, after: after.assigneeId },
        });
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

      return row as IssueRow;
    });

    return c.json(serializeIssue(updated));
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
