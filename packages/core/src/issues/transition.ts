import { Hono } from 'hono';
import { z } from 'zod';
import { type IssueStatus, issueStatuses, waitingKinds } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { RefusalError } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import {
  type StatusTransitionResult,
  TransitionError,
  transitionIssueStatus,
} from './apply-transition.js';
import { liveBlockedDependentsOf } from './dependency-read.js';
import type { UnblockedDependent } from './drop-cascade.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { parkQuestionNotMinted } from './park-question.js';
import { issueParkRoutes } from './park-routes.js';
import { transitionIssueRow } from './read-service.js';
import { recordEventRoutes } from './record-events/routes.js';
import { refuseOffRecoveryEdge, withRecoveryHint } from './recovery-move.js';
import { refuseLegacyStatusFields } from './status-input.js';
import { requireHeld } from '../permissions/index.js';

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
    const dependents = await liveBlockedDependentsOf(issueIds);

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

/** `GET /:id/park` — where an issue at a park goes back to, beside the move that takes it there. */
transitionRoutes.route('/', issueParkRoutes);
transitionRoutes.route('/', recordEventRoutes);

transitionRoutes.post(
  '/:id/transition',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
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
      if (recovery) refuseOffRecoveryEdge(fromStatus, toStatus);
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
      step: result.step,
      reopenCount: result.reopenCount,
      transitionedAt: result.updatedAt,
      ...(unasked ? { warnings: [unasked] } : {}),
    });
  },
);
