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
  mergeStoredChangeRequest,
  openPullRequestsForIssue,
  projectionPipeReport,
  pullRequestNumbered,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import {
  issueScopeOf,
  mergedCommitShaSchema,
  mergeIdentityOf,
  recordIssueMerge,
  recordRefusedStamp,
  type TransitionActor,
} from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { logger } from '../lib/logger.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import {
  admitChangeRequestMerge,
  promotionPinnedFor,
  settleChangeRequestRelease,
} from '../release-batch/index.js';

const refuse = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

/**
 * The stamp Forge's own merge writes, in the transaction that marks the projection row: the host's
 * landing commit, its time, the branch it landed on and the request's head with whether its tree is
 * the landing's, each read from the host. A later merge of another request delivering the issue
 * supersedes it (`recordIssueMerge`). Taken only where the commit is the issue's landing
 * (`issues/merge-identity.ts`); a refusal is recorded on the issue and answered beside the merge.
 */
const stampKernelMerge =
  (actor: OutboxActor, projectId: string): IssueMergeStamp =>
  async (tx, { pullRequestId, performed, issueId, commitSha, mergedAt, target, head }) => {
    // only a merge Forge made now names its request; one the host reports already made may have
    // landed through another request's commits, so the commit answers for it
    const identity = await mergeIdentityOf({
      projectId,
      commitSha,
      mergedRequestId: performed ? pullRequestId : null,
    })(issueId);
    if (!identity.holds) {
      await recordRefusedStamp(tx, {
        issueId,
        actor,
        commitSha,
        target,
        via: 'kernel',
        refusal: identity,
      });
      return { wrote: false, refused: { code: identity.code, detail: identity.detail } };
    }
    return recordIssueMerge(tx, {
      issueId,
      actor,
      via: 'kernel',
      evidence: { kind: 'observed', commitSha, mergedAt, target, hostMerge: { head } },
    });
  };

/**
 * The release this merge was a step of, settled where it was the last. The merge has already
 * happened, so a settle that fails is said in the answer beside it, never as the merge failing.
 */
async function settleAfterMerge(runId: string, actor: TransitionActor) {
  try {
    return { runId, ...(await settleChangeRequestRelease(runId, actor)) };
  } catch (err) {
    logger.error({ err, runId }, 'merge-pull-request: the release could not be settled');
    return { runId, settled: false, settleError: err instanceof Error ? err.message : String(err) };
  }
}

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
    const id =
      (await pullRequestNumbered(issueId, number)) ?? (await promotionPinnedFor(issueId, number));
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

    // on a project that releases through change requests, a merge is a step of an approved
    // release, in its order, at the head it was approved at (REQ-63 BC-2); refused by name otherwise
    const admitted = await admitChangeRequestMerge({
      projectId: issue.projectId,
      pullRequestId: stored.id,
    });
    const expectedHeadSha =
      body.headSha ?? (admitted.kind === 'release' ? admitted.headSha : undefined);

    const actor = restActor(c);
    try {
      const outcome = await mergeStoredChangeRequest(
        {
          pullRequestId: stored.id,
          requestedBy: `${actor.type}:${actor.id}`,
          runId: body.runId ?? null,
          ...(expectedHeadSha ? { expectedHeadSha } : {}),
          ...(body.method ? { method: body.method } : {}),
        },
        stampKernelMerge(actor, issue.projectId),
      );
      if (!outcome) throw notFound('pull request not found');
      if (outcome.kind === 'refused') {
        throw refuse('MERGE_REFUSED', `${outcome.detail} (${outcome.reason})`);
      }
      // the last request of a release closes it: its roster, its ship and its run
      const release =
        admitted.kind === 'release'
          ? await settleAfterMerge(admitted.runId, {
              type: 'user',
              id: userId,
              agency: actor.agency,
            })
          : null;
      return c.json({
        id: issueId,
        merged: true,
        alreadyMerged: outcome.kind === 'already-merged',
        // the merge call went unconfirmed and the request read back merged: what that call hit
        observedAfter: outcome.observedAfter,
        commitSha: outcome.commitSha,
        target: outcome.target,
        mergedAt: outcome.mergedAt.toISOString(),
        stamped: outcome.stamped,
        stampedIssues: outcome.stampedIssues,
        refusedStamps: outcome.refusedStamps,
        checks: outcome.checks,
        release,
        deliveryId: outcome.deliveryId,
      });
    } catch (err) {
      if (err instanceof SourceHostUnavailable) {
        throw refuse('NO_BINDING', err.message);
      }
      throw err;
    }
  },
);
