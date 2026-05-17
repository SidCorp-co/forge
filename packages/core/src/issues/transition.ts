import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  issueDependencies,
  issueStatuses,
  issues,
  projectMembers,
  projects,
} from '../db/schema.js';
import { dispatchTickForProject } from '../jobs/dispatch-tick.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { closeOpenRunForIssue, setCurrentStepForOpenIssueRun } from '../pipeline/runs.js';
import {
  REOPEN_CAP,
  canTransition,
  getAllowedTransitions,
  isReopenEntry,
} from '../pipeline/state-machine.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';

const transitionBodySchema = z
  .object({
    toStatus: z.enum(issueStatuses),
    reason: z.string().trim().min(1).max(2000).optional(),
    override: z.boolean().optional().default(false),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = () =>
  new HTTPException(404, { message: 'issue not found', cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string, code = 'FORBIDDEN') =>
  new HTTPException(403, { message, cause: { code } });

/** Issue statuses that satisfy a `kind='blocks'` dependency edge (Layer 2). */
export const TERMINAL_FOR_DISPATCH = new Set<IssueStatus>(['released', 'closed']);

/**
 * Inline `issue.statusChanged` WS publish. Shared by the single-issue
 * `/transition` route and the `/batch` route so both emit the same payload
 * shape. The bus subscriber for `transition` intentionally does NOT broadcast
 * `issue.statusChanged` (see `ws/broadcast-subscribers.ts:38`); writers must
 * publish inline to avoid double-emit on the single-issue path.
 */
export function publishIssueStatusChange(
  projectId: string,
  payload: {
    issueId: string;
    from: IssueStatus;
    to: IssueStatus;
    reopenCount: number;
    actorId: string;
    reason: string | null;
    at: Date;
  },
): void {
  roomManager.publish(projectRoom(projectId), {
    event: 'issue.statusChanged',
    data: payload,
  });
}

/** Cap on the number of dependents named in a single `issue.unblockCascade`
 *  event payload. Anything above is summarised as `+N more` on the toast. */
const UNBLOCK_CASCADE_DEPENDENT_CAP = 10;

/**
 * Layer-2 fan-out for terminal transitions: tick the parent project and any
 * distinct child project reachable via `kind='blocks'` outgoing edges from
 * the given issue ids. Best-effort — a 60s pg-boss backstop catches misses.
 *
 * Accepts a batch of (issueId, projectId, issSeq) pairs so the batch route
 * runs a single `inArray` query for child fan-out instead of N per-issue
 * queries. `issSeq` is included so the project-room broadcast can name the
 * blocker without a follow-up lookup. Per-blocker, this also publishes one
 * `issue.unblockCascade` envelope into the blocker's project room when the
 * blocker has at least one outgoing `kind='blocks'` dependent — the toast
 * confirms the cascade fired before the dispatcher tick lands.
 */
export async function triggerTerminalDispatch(
  terminal: Array<{ issueId: string; projectId: string; issSeq?: number | null; at?: Date }>,
): Promise<void> {
  if (terminal.length === 0) return;
  const parentProjectIds = new Set(terminal.map((t) => t.projectId));

  const childTargets = new Map<string, string>(); // childProjectId -> blockerIssueId
  try {
    const issueIds = terminal.map((t) => t.issueId);
    const dependents = await db
      .select({
        fromIssueId: issueDependencies.fromIssueId,
        toIssueId: issueDependencies.toIssueId,
        depProjectId: issueDependencies.projectId,
        toIssSeq: issues.issSeq,
      })
      .from(issueDependencies)
      .innerJoin(issues, eq(issues.id, issueDependencies.toIssueId))
      .where(
        and(
          inArray(issueDependencies.fromIssueId, issueIds),
          eq(issueDependencies.kind, 'blocks'),
          sql`(${issueDependencies.validUntil} IS NULL OR ${issueDependencies.validUntil} > now())`,
        ),
      );

    const byBlocker = new Map<string, Array<{ issueId: string; issSeq: number }>>();
    for (const row of dependents) {
      if (row.depProjectId && !parentProjectIds.has(row.depProjectId)) {
        if (!childTargets.has(row.depProjectId)) {
          childTargets.set(row.depProjectId, row.fromIssueId);
        }
      }
      const list = byBlocker.get(row.fromIssueId) ?? [];
      list.push({ issueId: row.toIssueId, issSeq: row.toIssSeq });
      byBlocker.set(row.fromIssueId, list);
    }

    for (const t of terminal) {
      const list = byBlocker.get(t.issueId);
      if (!list || list.length === 0) continue;
      roomManager.publish(projectRoom(t.projectId), {
        event: 'issue.unblockCascade',
        data: {
          blockerId: t.issueId,
          blockerIssSeq: t.issSeq ?? null,
          dependents: list.slice(0, UNBLOCK_CASCADE_DEPENDENT_CAP),
          overflow: Math.max(0, list.length - UNBLOCK_CASCADE_DEPENDENT_CAP),
          at: (t.at ?? new Date()).toISOString(),
        },
      });
    }
  } catch {
    // Cascade broadcast + child collection are best-effort; the 60s backstop
    // recovers missed unblocks and we'd rather lose a toast than a dispatch.
  }

  for (const projectId of parentProjectIds) {
    const blockerIssueId = terminal.find((t) => t.projectId === projectId)?.issueId;
    void dispatchTickForProject(
      projectId,
      blockerIssueId ? { triggerBlockerIssueId: blockerIssueId } : undefined,
    );
  }
  for (const [childProjectId, blockerIssueId] of childTargets) {
    void dispatchTickForProject(childProjectId, { triggerBlockerIssueId: blockerIssueId });
  }
}

export const transitionRoutes = new Hono<{ Variables: AuthVars }>();

transitionRoutes.use('*', requireAuth(), assertEmailVerified());

transitionRoutes.post(
  '/:id/transition',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', transitionBodySchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { toStatus, reason, override } = c.req.valid('json');
    const userId = c.get('userId');

    const [issue] = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        status: issues.status,
        reopenCount: issues.reopenCount,
        issSeq: issues.issSeq,
      })
      .from(issues)
      .where(eq(issues.id, id))
      .limit(1);
    if (!issue) throw notFound();

    const fromStatus = issue.status as IssueStatus;

    const [member] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, issue.projectId), eq(projectMembers.userId, userId)))
      .limit(1);
    if (!member) throw forbidden('not a project member');

    if (fromStatus === toStatus) {
      throw new HTTPException(409, {
        message: 'issue already in toStatus',
        cause: { code: 'NO_OP', details: { status: fromStatus } },
      });
    }

    if (!canTransition(fromStatus, toStatus)) {
      throw new HTTPException(409, {
        message: `illegal transition from ${fromStatus} to ${toStatus}`,
        cause: {
          code: 'ILLEGAL_TRANSITION',
          details: {
            from: fromStatus,
            to: toStatus,
            allowed: getAllowedTransitions(fromStatus),
          },
        },
      });
    }

    const reopening = isReopenEntry(fromStatus, toStatus);

    if (reopening) {
      if (issue.reopenCount >= REOPEN_CAP && !override) {
        throw new HTTPException(422, {
          message: `reopen cap reached (${REOPEN_CAP})`,
          cause: {
            code: 'REOPEN_CAP_EXCEEDED',
            details: { reopenCount: issue.reopenCount, max: REOPEN_CAP },
          },
        });
      }
      if (override) {
        const [project] = await db
          .select({ ownerId: projects.ownerId })
          .from(projects)
          .where(eq(projects.id, issue.projectId))
          .limit(1);
        const isOwner = (project && project.ownerId === userId) || member.role === 'owner';
        if (!isOwner) throw forbidden('override requires project owner', 'OVERRIDE_DENIED');
      }
    }

    // Conditional UPDATE gates on current status so concurrent transitions
    // can't both win. activity_log write is owned by F5; do not insert here.
    const [updated] = await db
      .update(issues)
      .set({
        status: toStatus,
        reopenCount: reopening ? sql`${issues.reopenCount} + 1` : issues.reopenCount,
        updatedAt: sql`now()`,
      })
      .where(and(eq(issues.id, id), eq(issues.status, fromStatus)))
      .returning({
        id: issues.id,
        status: issues.status,
        reopenCount: issues.reopenCount,
        updatedAt: issues.updatedAt,
      });

    if (!updated) {
      throw new HTTPException(409, {
        message: 'issue status changed concurrently',
        cause: { code: 'STALE_TRANSITION', details: { from: fromStatus, to: toStatus } },
      });
    }

    await hooks.emit('transition', {
      issueId: updated.id,
      projectId: issue.projectId,
      actor: { type: 'user', id: userId },
      from: fromStatus,
      to: toStatus,
      reopenCount: updated.reopenCount,
      ...(reason ? { reason } : {}),
    });

    publishIssueStatusChange(issue.projectId, {
      issueId: updated.id,
      from: fromStatus,
      to: toStatus,
      reopenCount: updated.reopenCount,
      actorId: userId,
      reason: reason ?? null,
      at: updated.updatedAt,
    });

    // ISS-164 — derived pipelineHealth needs a refresh whenever `stage` changes.
    await publishPipelineHealthChanged(issue.projectId, [updated.id]);

    // ISS-101 — stamp current_step on the issue's open run so the run timeline
    // reflects status, then close the run on terminal transitions. The picker
    // already filters `r.status = 'running'`, but closing here is defence in
    // depth + needed for the analytics/UI views in follow-up issues.
    await setCurrentStepForOpenIssueRun(issue.id, toStatus);

    // ISS-40 PR-E — when an issue reaches a terminal status it may unblock
    // children via Layer 2. Tick this project, plus every distinct child
    // project for cross-project blocking edges.
    if (TERMINAL_FOR_DISPATCH.has(toStatus)) {
      await closeOpenRunForIssue(issue.id, 'completed');
      await triggerTerminalDispatch([
        {
          issueId: issue.id,
          projectId: issue.projectId,
          issSeq: issue.issSeq,
          at: updated.updatedAt,
        },
      ]);
    }

    return c.json({
      id: updated.id,
      status: updated.status,
      reopenCount: updated.reopenCount,
      transitionedAt: updated.updatedAt,
    });
  },
);
