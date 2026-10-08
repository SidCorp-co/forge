import { checklistsOn } from '@forge/contracts/checklist-registry';
import { moveAnswersSchemaOf, parseAnswers } from '@forge/contracts/checklists';
import { REASON_PARAGRAPH_MAX } from '@forge/contracts/comments';
import { ISSUE_MACHINE } from '@forge/contracts/issue-machine';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { type IssueStatus, issueStatuses, waitingKinds } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { reportFailure } from '../lib/error-tracking.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import { isRefusal, RefusalError } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { holdChatWrite } from '../middleware/chat-write-hold.js';
import { idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { emitEvent } from '../outbox/index.js';
import { requireHeld } from '../permissions/index.js';
import { type StatusTransitionResult, transitionIssueStatus } from './apply-transition.js';
import { liveBlockedDependentsOf } from './dependency-read.js';
import type { UnblockedDependent } from './drop-cascade.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { issueChecklistRoutes } from './checklist-routes.js';
import { issueParkRoutes } from './park-routes.js';
import { transitionIssueRow } from './read-service.js';
import { recordEventRoutes } from './record-events/routes.js';
import { withRecoveryHint } from './recovery-move.js';
import { refuseLegacyStatusFields } from './status-input.js';

const transitionBodySchema = z
  .object({
    toStatus: z.enum(issueStatuses),
    reason: z.string().trim().min(1).max(REASON_PARAGRAPH_MAX).optional(),
    waitingKind: z.enum(waitingKinds).optional(),
    needs: z.string().trim().min(1).max(2000).optional(),
    awaitsDesign: z
      .object({ workflowId: z.uuid(), revision: z.number().int().min(1) })
      .strict()
      .optional(),
    awaitsMerge: z.object({ issueId: z.uuid() }).strict().optional(),
    voidQuestions: z.string().max(2000).optional(),
    recovery: z.literal(true).optional(),
    // the answers to the checklist the move's edge names, derived from that checklist's definition
    answers: moveAnswersSchemaOf(checklistsOn(ISSUE_MACHINE)).optional(),
  })
  .strict();

/**
 * Answers the body schema refused, refused instead as the kernel would refuse them, by the
 * checklist of the edge into `toStatus`, so every door answers a wrong answer alike.
 */
function refuseInvalidAnswers(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const { toStatus, answers } = raw as { toStatus?: unknown; answers?: unknown };
  if (answers === undefined) return;
  const into = checklistsOn(ISSUE_MACHINE).filter((c) => c.gates.to === toStatus);
  const [checklist] = into;
  if (!checklist || into.length > 1) return;
  const parsed = parseAnswers(checklist, answers);
  if (!parsed.ok) throw new RefusalError(parsed.refusals, 'CHECKLIST_ANSWER_INVALID');
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
    await emitEvent(db, 'issue.pushed', {
      projectId: t.projectId,
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

/** A side effect of a committed move that did not happen: named on the answer, never a 500. */
interface AfterCommitFailure {
  effect: 'unblock_cascade';
  detail: string;
}

const AFTER_COMMIT_DETAIL: Record<AfterCommitFailure['effect'], string> = {
  unblock_cascade:
    "the move committed, and the notice telling this project's room which dependents it unblocked could not be written; the dependents are admissible regardless, and the failure is reported to error tracking",
};

/**
 * Run what follows a committed move. The move is the answer: a failure here is logged, reported
 * and named on the response, and never turned into a 500 that tells the caller the move did not
 * happen (hop ISS-29 and ISS-19 answered 500 on a committed `awaiting_release`).
 */
async function afterCommit(
  effect: AfterCommitFailure['effect'],
  subject: { issueId: string; toStatus: IssueStatus },
  run: () => Promise<void>,
): Promise<AfterCommitFailure | null> {
  try {
    await run();
    return null;
  } catch (err) {
    logger.error({ err, effect, ...subject }, 'transition: a side effect after the commit failed');
    reportFailure(err, {
      tags: { area: 'issues', phase: `transition.${effect}` },
      extra: subject,
    });
    return { effect, detail: AFTER_COMMIT_DETAIL[effect] };
  }
}

export const transitionRoutes = new Hono<{ Variables: AuthVars }>();

transitionRoutes.use('*', requireAuth(), assertEmailVerified());

/** `GET /:id/park` — where an issue at a park goes back to, beside the move that takes it there. */
transitionRoutes.route('/', issueParkRoutes);
transitionRoutes.route('/', issueChecklistRoutes);
transitionRoutes.route('/', recordEventRoutes);

transitionRoutes.post(
  '/:id/transition',
  zValidator('param', idParamSchema),
  zValidator('json', transitionBodySchema, (result) => {
    if (!result.success) {
      refuseLegacyStatusFields(result.data, 'json', ['toStatus']);
      refuseInvalidAnswers(result.data);
    }
  }),
  // a chat's status move (draft to open dispatches) waits for the person's press (REQ-30 BC-4)
  holdChatWrite('issue_change'),
  async (c) => {
    const { id } = c.req.valid('param');
    const {
      toStatus,
      reason,
      waitingKind,
      needs,
      awaitsDesign,
      awaitsMerge,
      voidQuestions,
      recovery,
      answers,
    } = c.req.valid('json');
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
          awaitsDesign,
          awaitsMerge,
          voidQuestions,
          answers,
          ...(recovery ? { recovery } : {}),
        },
      );
    } catch (err) {
      if (isRefusal(err)) throw withRecoveryHint(err, fromStatus, toStatus, recovery);
      throw err;
    }

    const unreported = result.terminal
      ? await afterCommit('unblock_cascade', { issueId: issue.id, toStatus }, () =>
          publishUnblockCascade([
            {
              issueId: issue.id,
              projectId: issue.projectId,
              issSeq: issue.issSeq,
              at: result.updatedAt,
              ...(toStatus === 'dropped' ? { dependents: result.unblockedDependents } : {}),
            },
          ]),
        )
      : null;

    return c.json({
      id: result.id,
      status: result.status,
      step: result.step,
      reopenCount: result.reopenCount,
      transitionedAt: result.updatedAt,
      ...(unreported ? { afterCommitFailures: [unreported] } : {}),
    });
  },
);
