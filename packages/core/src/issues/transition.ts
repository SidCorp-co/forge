import { Hono } from 'hono';
import { z } from 'zod';
import { type IssueStatus, issueStatuses, waitingKinds } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { RefusalError } from '../lib/refusal.js';
import { projectRoom, roomManager } from '../lib/rooms.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import {
  type StatusTransitionResult,
  TransitionError,
  transitionIssueStatus,
} from './apply-transition.js';
import { liveBlockedDependentsOf } from './dependency-read.js';
import type { UnblockedDependent } from './drop-cascade.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { issueParkRoutes } from './park-routes.js';
import { transitionIssueRow } from './read-service.js';
import { recordEventRoutes } from './record-events/routes.js';
import { withRecoveryHint } from './recovery-move.js';
import { refuseLegacyStatusFields } from './status-input.js';

const transitionBodySchema = z
  .object({
    toStatus: z.enum(issueStatuses),
    reason: z.string().trim().min(1).max(2000).optional(),
    waitingKind: z.enum(waitingKinds).optional(),
    needs: z.string().trim().min(1).max(2000).optional(),
    voidQuestions: z.string().max(2000).optional(),
    recovery: z.literal(true).optional(),
  })
  .strict();

/**
 * A refused move answers in the one envelope under the guard's own code and declared status, its
 * structured facts (`openQuestionIds`, `requires`, …) on the refusal row.
 */
function transitionRefusal(err: TransitionError): RefusalError {
  return new RefusalError(
    [{ ...err.details, code: err.code, path: '', detail: err.detail }],
    err.code,
  );
}

/** Cap on the number of dependents named in a single `issue.unblockCascade`
 *  event payload. Anything above is summarised as `+N more` on the toast. */
const UNBLOCK_CASCADE_DEPENDENT_CAP = 10;

/**
 * Tells each blocker's project room which dependents its terminal move unblocked: one
 * `issue.unblockCascade` toast per blocker that had any. Dispatch needs nothing from here — an
 * unblocked issue is admissible on the next claim.
 */
export async function publishUnblockCascade(
  terminal: Array<{
    issueId: string;
    projectId: string;
    issSeq?: number | null;
    at?: Date;
    dependents?: UnblockedDependent[];
  }>,
): Promise<void> {
  if (terminal.length === 0) return;
  const byBlocker = new Map<
    string,
    Array<{ issueId: string; issSeq: number; displayId: string }>
  >();
  const pending: Array<{
    blockerId: string;
    issueId: string;
    issSeq: number;
    projectId: string | null;
  }> = [];

  for (const t of terminal) {
    if (!t.dependents) continue;
    for (const d of t.dependents) {
      pending.push({
        blockerId: t.issueId,
        issueId: d.issueId,
        issSeq: d.issSeq,
        projectId: d.projectId,
      });
    }
  }

  const issueIds = terminal.filter((t) => !t.dependents).map((t) => t.issueId);
  const dependents = await liveBlockedDependentsOf(issueIds);

  for (const row of dependents) {
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
      displayId: formatIssueRef(d.projectId ? (prefixOf.get(d.projectId) ?? null) : null, d.issSeq),
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
}

export const transitionRoutes = new Hono<{ Variables: AuthVars }>();

transitionRoutes.use('*', requireAuth(), assertEmailVerified());

/** `GET /:id/park` — where an issue at a park goes back to, beside the move that takes it there. */
transitionRoutes.route('/', issueParkRoutes);
transitionRoutes.route('/', recordEventRoutes);

transitionRoutes.post(
  '/:id/transition',
  zValidator('param', idParamSchema),
  zValidator('json', transitionBodySchema, (result) => {
    if (!result.success) {
      refuseLegacyStatusFields(result.data, 'json', ['toStatus']);
      throw badRequest(result.error);
    }
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { toStatus, reason, waitingKind, needs, voidQuestions, recovery } = c.req.valid('json');
    const userId = c.get('userId');

    const issue = await transitionIssueRow(id);
    if (!issue) throw notFound('issue not found');

    const fromStatus = issue.status as IssueStatus;

    const access = await loadProjectAccess(issue.projectId, userId);
    requireHeld(access, 'project.write');
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
        {
          reason,
          transitionReason: reason,
          waitingKind,
          needs,
          voidQuestions,
          ...(recovery ? { recovery } : {}),
        },
      );
    } catch (err) {
      if (err instanceof TransitionError) {
        throw transitionRefusal(withRecoveryHint(err, fromStatus, toStatus, recovery));
      }
      throw err;
    }

    if (result.terminal) {
      await publishUnblockCascade([
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
      step: result.step,
      reopenCount: result.reopenCount,
      transitionedAt: result.updatedAt,
    });
  },
);
