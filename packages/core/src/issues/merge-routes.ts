/**
 * The merge claim, as its own route module.
 *
 * `merged_at` is not a field like the others: `jobs/queued-gates.ts` reads it
 * to release every `blocks` dependent, so writing it says work shipped. These
 * two routes exist so an agent on the CLI can say that over REST instead of
 * through `forge_issues.mark_merged`.
 *
 * ISS-959 — the mark also records the commit it was made at, so the claim is
 * checkable rather than a judgement call read out of the note's prose.
 *
 * ISS-1073 put the OTHER door here, beside it, and the two read as a pair on
 * purpose: `POST /:id/merge` is a claim that work shipped, and
 * `POST /:id/merge-pull-request` is the operation that ships it. The first takes
 * somebody's word and stamps a timestamp; the second merges as the App and the
 * same operation writes the timestamp AND the commit, so a reader comparing them
 * can see which kind of record they are asking for. The floor differs for the
 * same reason: a claim needs `member`, and a write to the repository needs
 * `member` for both.
 */

import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import { GitHubClientError } from '../integrations/github/client.js';
import { openPullRequestsForIssue } from '../integrations/github/contract-check.js';
import {
  MERGE_METHODS,
  MergeInputError,
  mergeStoredPullRequest,
} from '../integrations/github/merge.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { applyMergeMarker, MergeMarkerError, mergedCommitShaSchema } from './merge-marker.js';

const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const issueMergeRoutes = new Hono<{ Variables: AuthVars }>();

issueMergeRoutes.use('*', requireAuth(), assertEmailVerified());

const mergeMarkerBodySchema = z
  .object({
    target: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().min(1).max(2000).optional(),
    commit: mergedCommitShaSchema.optional(),
    mergedAt: z.iso.datetime().optional(),
  })
  .strict();

async function runMergeMarker(
  c: Context<{ Variables: AuthVars }>,
  op: 'mark' | 'unmark',
): Promise<Response> {
  const { id: issueId } = c.req.valid('param' as never) as { id: string };
  const body = c.req.valid('json' as never) as z.infer<typeof mergeMarkerBodySchema>;
  const userId = c.get('userId');

  const [issue] = await db
    .select({ id: issues.id, projectId: issues.projectId, mergedAt: issues.mergedAt })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue) throw notFound('issue not found');

  const access = await loadProjectAccess(issue.projectId, userId);
  assertProjectRole(access, 'member');

  if (op === 'mark' && !body.target) {
    throw badRequest({ formErrors: ['target is required'], fieldErrors: {} });
  }

  const actor = restActor(c);
  try {
    const { action } = await applyMergeMarker({
      issue,
      op,
      ...(body.target ? { target: body.target } : {}),
      ...(body.note ? { note: body.note } : {}),
      ...(body.commit ? { commit: body.commit } : {}),
      ...(body.mergedAt ? { mergedAt: new Date(body.mergedAt) } : {}),
      actor: {
        agency: actor.agency,
        commentAuthorId: userId,
        hookActor: { type: actor.type, id: actor.id, agency: actor.agency },
      },
    });
    return c.json({ id: issueId, action });
  } catch (err) {
    if (err instanceof MergeMarkerError) {
      if (err.code === 'ISSUE_NOT_FOUND') throw notFound('issue not found');
      throw new HTTPException(422, {
        message: err.message,
        cause: { code: err.code },
      });
    }
    throw err;
  }
}

const mergeMarkerValidators = [
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', mergeMarkerBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
] as const;

issueMergeRoutes.post('/:id/merge', ...mergeMarkerValidators, (c) => runMergeMarker(c, 'mark'));
issueMergeRoutes.delete('/:id/merge', ...mergeMarkerValidators, (c) => runMergeMarker(c, 'unmark'));

const kernelMergeBodySchema = z
  .object({
    /** The pull request NUMBER as GitHub shows it. Absent resolves the issue's one open request. */
    pullRequest: z.number().int().positive().optional(),
    /** The head the caller judged. A head that moved since is refused, never re-aimed. */
    headSha: mergedCommitShaSchema.optional(),
    runId: z.uuid().optional(),
    method: z.enum(MERGE_METHODS).optional(),
  })
  .strict();

/** The stored pull request this call is about, or the sentence saying why there is none. */
async function resolveStoredPullRequest(
  issueId: string,
  number: number | undefined,
): Promise<{ id: string } | { refusal: string }> {
  if (number !== undefined) {
    const [row] = await db
      .select({ id: repoPullRequests.id })
      .from(repoPullRequests)
      .where(and(eq(repoPullRequests.issueId, issueId), eq(repoPullRequests.number, number)))
      .limit(1);
    return row
      ? { id: row.id }
      : {
          refusal: `this issue has no pull request #${number} on Forge's projection of the repository`,
        };
  }
  const open = await openPullRequestsForIssue(issueId);
  if (open.length === 0) {
    return {
      refusal:
        "this issue has no open pull request on Forge's projection of the repository — name one with `pullRequest`, or check that the branch names this issue",
    };
  }
  if (open.length > 1) {
    return {
      refusal: `this issue has ${open.length} open pull requests and Forge will not choose between them — name the one to merge with \`pullRequest\``,
    };
  }
  return { id: open[0] as string };
}

issueMergeRoutes.post(
  '/:id/merge-pull-request',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', kernelMergeBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param' as never) as { id: string };
    const body = c.req.valid('json' as never) as z.infer<typeof kernelMergeBodySchema>;
    const userId = c.get('userId');

    const [issue] = await db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    assertProjectRole(access, 'member');

    const stored = await resolveStoredPullRequest(issueId, body.pullRequest);
    if ('refusal' in stored) {
      throw new HTTPException(422, {
        message: stored.refusal,
        cause: { code: 'NO_PULL_REQUEST' },
      });
    }

    const actor = restActor(c);
    try {
      const outcome = await mergeStoredPullRequest({
        pullRequestId: stored.id,
        requestedBy: `${actor.type}:${actor.id}`,
        runId: body.runId ?? null,
        ...(body.headSha ? { expectedHeadSha: body.headSha } : {}),
        ...(body.method ? { method: body.method } : {}),
      });
      if (!outcome) throw notFound('pull request not found');
      if (outcome.kind === 'refused') {
        throw new HTTPException(422, {
          message: outcome.detail,
          cause: { code: 'MERGE_REFUSED', reason: outcome.reason },
        });
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
        throw new HTTPException(400, {
          message: err.message,
          cause: { code: 'BAD_REQUEST' },
        });
      }
      if (err instanceof GitHubClientError) {
        throw new HTTPException(422, { message: err.message, cause: { code: 'NO_BINDING' } });
      }
      throw err;
    }
  },
);
