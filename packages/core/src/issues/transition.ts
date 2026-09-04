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
  waitingKinds,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import {
  type StatusTransitionResult,
  TransitionError,
  transitionIssueStatus,
} from './apply-transition.js';
import type { UnblockedDependent } from './drop-cascade.js';

const transitionBodySchema = z
  .object({
    toStatus: z.enum(issueStatuses),
    reason: z.string().trim().min(1).max(2000).optional(),
    // cm:guard optional here on purpose (RFC 0002 INV-5) — a UI that cannot ask the user which kind must send nothing rather than a default, because a wrong kind renders a wrong banner and only a human can correct it
    waitingKind: z.enum(waitingKinds).optional(),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = () =>
  new HTTPException(404, { message: 'issue not found', cause: { code: 'NOT_FOUND' } });

const _forbidden = (message: string, code = 'FORBIDDEN') =>
  new HTTPException(403, { message, cause: { code } });

/**
 * Map a core `TransitionError` onto the REST error contract. Status codes and
 * messages are part of the public API — keep them stable.
 */
function transitionErrorToHttp(err: TransitionError): HTTPException {
  const cause = { code: err.code, details: err.details };
  switch (err.code) {
    case 'NO_OP':
      return new HTTPException(409, { message: 'issue already in toStatus', cause });
    case 'TRANSITION_REASON_REQUIRED':
    case 'WAITING_KIND_REQUIRED':
    case 'RELEASE_RECORD_REQUIRED':
      return new HTTPException(422, { message: err.detail, cause });
    case 'PLAN_REQUIRED':
      return new HTTPException(409, { message: err.detail, cause });
    case 'NO_WORK_EVIDENCE':
      return new HTTPException(409, { message: err.detail, cause });
    default:
      // ILLEGAL_TRANSITION | STALE_TRANSITION
      return new HTTPException(409, { message: err.detail, cause });
  }
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
// cm:guard an entry carrying `dependents` must NOT be re-queried — a `dropped` blocker has already had its edges expired inside the transition and the query below filters expired edges out, so re-deriving finds nothing and the cascade goes unannounced on the one status that needs it most
export async function triggerTerminalDispatch(
  terminal: Array<{
    issueId: string;
    projectId: string;
    issSeq?: number | null;
    at?: Date;
    dependents?: UnblockedDependent[];
  }>,
): Promise<void> {
  if (terminal.length === 0) return;
  const parentProjectIds = new Set(terminal.map((t) => t.projectId));

  const childTargets = new Map<string, string>(); // childProjectId -> blockerIssueId
  try {
    const byBlocker = new Map<string, Array<{ issueId: string; issSeq: number }>>();
    const noteChild = (depProjectId: string | null, blockerId: string) => {
      if (depProjectId && !parentProjectIds.has(depProjectId) && !childTargets.has(depProjectId)) {
        childTargets.set(depProjectId, blockerId);
      }
    };

    for (const t of terminal) {
      if (!t.dependents) continue;
      for (const d of t.dependents) {
        noteChild(d.projectId, t.issueId);
        const list = byBlocker.get(t.issueId) ?? [];
        list.push({ issueId: d.issueId, issSeq: d.issSeq });
        byBlocker.set(t.issueId, list);
      }
    }

    const issueIds = terminal.filter((t) => !t.dependents).map((t) => t.issueId);
    const dependents =
      issueIds.length === 0
        ? []
        : await db
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

    for (const row of dependents) {
      noteChild(row.depProjectId, row.fromIssueId);
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
    // cm:why the cascade broadcast is a toast and nothing more — the edge rows are the record and a master reads those itself, so losing one costs a UI hint rather than a dispatch
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
    const { toStatus, reason, waitingKind } = c.req.valid('json');
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

    const access = await loadProjectAccess(issue.projectId, userId);
    assertProjectRole(access, 'member');

    let result: StatusTransitionResult;
    try {
      result = await transitionIssueStatus(
        {
          id: issue.id,
          projectId: issue.projectId,
          status: fromStatus,
          reopenCount: issue.reopenCount,
        },
        toStatus,
        restActor(c),
        { reason, transitionReason: reason, waitingKind },
      );
    } catch (err) {
      if (err instanceof TransitionError) throw transitionErrorToHttp(err);
      throw err;
    }

    // ISS-40 PR-E — when an issue reaches a terminal status it may unblock
    // children via Layer 2. Tick this project, plus every distinct child
    // project for cross-project blocking edges.
    if (result.terminal) {
      await triggerTerminalDispatch([
        {
          issueId: issue.id,
          projectId: issue.projectId,
          issSeq: issue.issSeq,
          at: result.updatedAt,
          ...(toStatus === 'dropped' ? { dependents: result.unblockedDependents } : {}),
        },
      ]);
    }

    return c.json({
      id: result.id,
      status: result.status,
      reopenCount: result.reopenCount,
      transitionedAt: result.updatedAt,
    });
  },
);
