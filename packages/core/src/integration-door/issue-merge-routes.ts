// `POST /api/issues/:id/merge-pull-request`: the operation that ships an issue's work, merging its
// pull request as the App through the source host and stamping `merged_at` and the commit in the
// same write. The claim beside it (`POST /:id/merge`) is the issue kernel's own route.

import type { MergeRefusalCode } from '@forge/contracts/issues';
import type { OutboxActor } from '@forge/contracts/outbox-events';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  CHANGE_REQUEST_MERGE_METHODS,
  describeEmptyProjection,
  type IssueMergeStamp,
  MergeInputError,
  mergeStoredChangeRequest,
  openPullRequestsForIssue,
  projectionPipeReport,
  pullRequestNumbered,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { issueScopeOf, mergedCommitShaSchema, recordIssueMerge } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';

const refuse = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

/** The stamp Forge's own merge writes, in the transaction that marks the projection row. */
const stampKernelMerge =
  (actor: OutboxActor): IssueMergeStamp =>
  (tx, { issueId, commitSha, mergedAt }) =>
    recordIssueMerge(tx, {
      issueId,
      actor,
      via: 'kernel',
      evidence: { kind: 'observed', commitSha, mergedAt },
    });

export const issueMergePullRequestRoutes = new Hono<{ Variables: AuthVars }>();

issueMergePullRequestRoutes.use('*', requireAuth(), assertEmailVerified());

const kernelMergeBodySchema = z
  .object({
    /** The pull request number or merge request iid as the host shows it. Absent resolves the issue's one open request. */
    pullRequest: z.number().int().positive().optional(),
    /** The head the caller judged. A head that moved since is refused, never re-aimed. */
    headSha: mergedCommitShaSchema.optional(),
    runId: z.uuid().optional(),
    method: z.enum(CHANGE_REQUEST_MERGE_METHODS).optional(),
  })
  .strict();

/**
 * The refusal for an issue with no row, with the two states told apart.
 *
 * ISS-1123: `NO_PULL_REQUEST` reads as "you named the wrong number", and for the first year of this
 * route's life it was never once true — the projection had a single writer nothing reached, so
 * EVERY pull request on EVERY project answered that sentence. A projection holding nothing at all
 * is reported as what it is, under its own code, before the number is blamed.
 */
async function noRowRefusal(
  projectId: string,
  about: string,
): Promise<{ refusal: string; code: 'NO_PULL_REQUEST' | 'PROJECTION_EMPTY' }> {
  const empty = describeEmptyProjection(await projectionPipeReport(projectId));
  return empty
    ? { refusal: empty, code: 'PROJECTION_EMPTY' }
    : { refusal: about, code: 'NO_PULL_REQUEST' };
}

/** The stored pull request this call is about, or the sentence saying why there is none. */
async function resolveStoredPullRequest(
  projectId: string,
  issueId: string,
  number: number | undefined,
): Promise<{ id: string } | { refusal: string; code: 'NO_PULL_REQUEST' | 'PROJECTION_EMPTY' }> {
  if (number !== undefined) {
    const id = await pullRequestNumbered(issueId, number);
    return id
      ? { id }
      : noRowRefusal(
          projectId,
          `this issue has no pull request #${number} on Forge's projection of the repository`,
        );
  }
  const open = await openPullRequestsForIssue(issueId);
  if (open.length === 0) {
    return noRowRefusal(
      projectId,
      "this issue has no open pull request on Forge's projection of the repository — name one with `pullRequest`, or check that the branch names this issue",
    );
  }
  if (open.length > 1) {
    return {
      refusal: `this issue has ${open.length} open pull requests and Forge will not choose between them — name the one to merge with \`pullRequest\``,
      code: 'NO_PULL_REQUEST',
    };
  }
  return { id: open[0] as string };
}

issueMergePullRequestRoutes.post(
  '/:id/merge-pull-request',
  zValidator('param', idParamSchema),
  zValidator('json', kernelMergeBodySchema),
  async (c) => {
    const { id: issueId } = c.req.valid('param' as never) as { id: string };
    const body = c.req.valid('json' as never) as z.infer<typeof kernelMergeBodySchema>;
    const userId = c.get('userId');

    const issue = await issueScopeOf(issueId);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    requireHeld(access, 'project.write');

    const stored = await resolveStoredPullRequest(issue.projectId, issueId, body.pullRequest);
    if ('refusal' in stored) {
      throw refuse(stored.code, stored.refusal, '/pullRequest');
    }

    const actor = restActor(c);
    try {
      const outcome = await mergeStoredChangeRequest(
        {
          pullRequestId: stored.id,
          requestedBy: `${actor.type}:${actor.id}`,
          runId: body.runId ?? null,
          ...(body.headSha ? { expectedHeadSha: body.headSha } : {}),
          ...(body.method ? { method: body.method } : {}),
        },
        stampKernelMerge(actor),
      );
      if (!outcome) throw notFound('pull request not found');
      if (outcome.kind === 'refused') {
        throw refuse('MERGE_REFUSED', `${outcome.detail} (${outcome.reason})`);
      }
      return c.json({
        id: issueId,
        merged: true,
        alreadyMerged: outcome.kind === 'already-merged',
        commitSha: outcome.commitSha,
        mergedAt: outcome.mergedAt.toISOString(),
        stamped: outcome.stamped,
        deliveryId: outcome.deliveryId,
      });
    } catch (err) {
      if (err instanceof MergeInputError) {
        throw refuse(err.code, err.message, err.code === 'MERGE_REQUESTER_MISSING' ? '' : '/runId');
      }
      if (err instanceof SourceHostUnavailable) {
        throw refuse('NO_BINDING', err.message);
      }
      throw err;
    }
  },
);
