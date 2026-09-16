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
import { formatIssueRef } from '../lib/issue-ref.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import {
  type StatusTransitionResult,
  TransitionError,
  transitionIssueStatus,
} from './apply-transition.js';
import type { UnblockedDependent } from './drop-cascade.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { parkQuestionNotMinted } from './park-question.js';

const transitionBodySchema = z
  .object({
    toStatus: z.enum(issueStatuses),
    reason: z.string().trim().min(1).max(2000).optional(),
    waitingKind: z.enum(waitingKinds).optional(),
    needs: z.string().trim().min(1).max(2000).optional(),
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
    case 'WAITING_KIND_NOT_APPLICABLE':
    case 'RELEASE_RECORD_REQUIRED':
    case 'ENTRY_CRITERIA_UNMET':
      return new HTTPException(422, { message: err.detail, cause });
    case 'NO_WORK_EVIDENCE':
      return new HTTPException(409, { message: err.detail, cause });
    default:
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

  const blockerIssueIdByChildProject = new Map<string, string>();
  try {
    const byBlocker = new Map<
      string,
      Array<{ issueId: string; issSeq: number; displayId: string }>
    >();
    const noteChild = (depProjectId: string | null, blockerId: string) => {
      if (
        depProjectId &&
        !parentProjectIds.has(depProjectId) &&
        !blockerIssueIdByChildProject.has(depProjectId)
      ) {
        blockerIssueIdByChildProject.set(depProjectId, blockerId);
      }
    };

    const pending: Array<{
      blockerId: string;
      issueId: string;
      issSeq: number;
      projectId: string | null;
    }> = [];

    for (const t of terminal) {
      if (!t.dependents) continue;
      for (const d of t.dependents) {
        noteChild(d.projectId, t.issueId);
        pending.push({
          blockerId: t.issueId,
          issueId: d.issueId,
          issSeq: d.issSeq,
          projectId: d.projectId,
        });
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
      pending.push({
        blockerId: row.fromIssueId,
        issueId: row.toIssueId,
        issSeq: row.toIssSeq,
        projectId: row.depProjectId,
      });
    }

    const prefixOf = new Map<string, string | null>(
      await Promise.all(
        [...new Set([...terminal.map((t) => t.projectId), ...pending.map((p) => p.projectId)])]
          .filter((id): id is string => typeof id === 'string')
          .map(async (id): Promise<[string, string | null]> => [id, await activeIssuePrefix(id)]),
      ),
    );

    for (const d of pending) {
      const list = byBlocker.get(d.blockerId) ?? [];
      list.push({
        issueId: d.issueId,
        issSeq: d.issSeq,
        displayId: formatIssueRef(
          d.projectId ? (prefixOf.get(d.projectId) ?? null) : null,
          d.issSeq,
        ),
      });
      byBlocker.set(d.blockerId, list);
    }

    for (const t of terminal) {
      const list = byBlocker.get(t.issueId);
      if (!list || list.length === 0) continue;
      roomManager.publish(projectRoom(t.projectId), {
        event: 'issue.unblockCascade',
        data: {
          blockerId: t.issueId,
          blockerIssSeq: t.issSeq ?? null,
          blockerDisplayId:
            t.issSeq == null ? null : formatIssueRef(prefixOf.get(t.projectId) ?? null, t.issSeq),
          dependents: list.slice(0, UNBLOCK_CASCADE_DEPENDENT_CAP),
          overflow: Math.max(0, list.length - UNBLOCK_CASCADE_DEPENDENT_CAP),
          at: (t.at ?? new Date()).toISOString(),
        },
      });
    }
  } catch {}
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
    const { toStatus, reason, waitingKind, needs } = c.req.valid('json');
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
        { reason, transitionReason: reason, waitingKind, needs },
      );
    } catch (err) {
      if (err instanceof TransitionError) throw transitionErrorToHttp(err);
      throw err;
    }

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

    const unasked = parkQuestionNotMinted({
      issue: { id: issue.id, projectId: issue.projectId },
      toStatus,
      actor: restActor(c),
      options: { needs },
    });
    return c.json({
      id: result.id,
      status: result.status,
      reopenCount: result.reopenCount,
      transitionedAt: result.updatedAt,
      ...(unasked ? { warnings: [unasked] } : {}),
    });
  },
);
