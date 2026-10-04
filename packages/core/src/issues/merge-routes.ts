/**
 * The merge claim, as its own route module.
 *
 * `merged_at` is not a field like the others: `jobs/queued-gates.ts` reads it
 * to release every `blocks` dependent, so writing it says work shipped. These
 * two routes are the one door that says it.
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

import type { MergeRefusalCode } from '@forge/contracts/issues';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { LANDED_CONTRACT } from '../ecosystem/contract/drift.js';
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
import { loadProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { mergedLandingSchema } from './landing-evidence.js';
import { applyMergeMarker, mergedCommitShaSchema } from './merge-marker.js';
import { recordIssueMerge } from './merge-record.js';
import { issueScopeOf } from './read-service.js';

const refuse = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

/** The stamp Forge's own merge writes, in the transaction that marks the projection row. */
export const stampKernelMerge: IssueMergeStamp = (tx, { issueId, commitSha, mergedAt }) =>
  recordIssueMerge(tx, { issueId, evidence: { kind: 'observed', commitSha, mergedAt, via: 'kernel' } });

export const issueMergeRoutes = new Hono<{ Variables: AuthVars }>();

issueMergeRoutes.use('*', requireAuth(), assertEmailVerified());

const mergeMarkerBodySchema = z
  .object({
    target: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().min(1).max(2000).optional(),
    commit: mergedCommitShaSchema.optional(),
    landing: mergedLandingSchema.optional(),
    mergedAt: z.iso.datetime().optional(),
    contracts: z
      .array(
        z.string().regex(LANDED_CONTRACT, 'a contract version is <project>/<contract>@<version>'),
      )
      .max(20)
      .optional(),
  })
  .strict();

async function runMergeMarker(
  c: Context<{ Variables: AuthVars }>,
  op: 'mark' | 'unmark',
): Promise<Response> {
  const { id: issueId } = c.req.valid('param' as never) as { id: string };
  const body = c.req.valid('json' as never) as z.infer<typeof mergeMarkerBodySchema>;
  const userId = c.get('userId');

  const scope = await issueScopeOf(issueId);
  if (!scope) throw notFound('issue not found');
  const issue = { id: scope.id, projectId: scope.projectId, mergedAt: scope.mergedAt };

  const access = await loadProjectAccess(issue.projectId, userId);
  requireHeld(access, 'project.write');

  const actor = restActor(c);
  const { action, mark, markDetail } = await applyMergeMarker({
    issue,
    op,
    ...(body.target ? { target: body.target } : {}),
    ...(body.note ? { note: body.note } : {}),
    ...(body.commit ? { commit: body.commit } : {}),
    ...(body.landing ? { landing: body.landing } : {}),
    ...(body.mergedAt ? { mergedAt: new Date(body.mergedAt) } : {}),
    ...(body.contracts ? { contracts: body.contracts } : {}),
    actor: {
      agency: actor.agency,
      commentAuthorId: userId,
      hookActor: { type: actor.type, id: actor.id, agency: actor.agency },
    },
  });
  // ISS-1126 — `mark` and `detail` say which kind of record this call left. Without them a
  // caller reads `action: 'merged'` and has no way to learn that what it wrote is a claim
  // Forge did not observe; the sentence has been composed for the audit trail since ISS-959
  // and never reached the one party that could act on it.
  return c.json({ id: issueId, action, mark, detail: markDetail });
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
        stampKernelMerge,
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
        throw new HTTPException(400, {
          message: err.message,
          cause: { code: 'BAD_REQUEST' },
        });
      }
      if (err instanceof SourceHostUnavailable) {
        throw refuse('NO_BINDING', err.message);
      }
      throw err;
    }
  },
);
