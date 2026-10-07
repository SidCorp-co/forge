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
 * ISS-1073 added the OTHER door, which merges through the source host and so is
 * the integration door's (`integration-door/issue-merge-routes.ts`); the two read
 * as a pair on purpose: `POST /:id/merge` is a claim that work shipped, and
 * `POST /:id/merge-pull-request` is the operation that ships it. The first takes
 * somebody's word and stamps a timestamp; the second merges as the App and the
 * same operation writes the timestamp AND the commit, so a reader comparing them
 * can see which kind of record they are asking for. The floor differs for the
 * same reason: a claim needs `member`, and a write to the repository needs
 * `member` for both.
 */

import { REASON_PARAGRAPH_MAX } from '@forge/contracts/comments';
import { LANDED_CONTRACT } from '@forge/contracts/ecosystem';
import { changedPathsSchema, landingArtifactsSchema } from '@forge/contracts/landing-artifacts';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { heldIssue } from './issue-route-ref.js';
import { mergedLandingSchema } from './landing-evidence.js';
import { applyMergeMarker, mergedCommitShaSchema } from './merge-marker.js';

export const issueMergeRoutes = new Hono<{ Variables: AuthVars }>();

issueMergeRoutes.use('*', requireAuth(), assertEmailVerified());

const mergeMarkerBodySchema = z
  .object({
    target: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().min(1).max(REASON_PARAGRAPH_MAX).optional(),
    commit: mergedCommitShaSchema.optional(),
    landing: mergedLandingSchema.optional(),
    artifacts: landingArtifactsSchema.optional(),
    changedPaths: changedPathsSchema.optional(),
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

  const scope = await heldIssue(issueId, userId, 'project.write');
  const issue = { id: scope.id, projectId: scope.projectId, mergedAt: scope.mergedAt };

  const actor = restActor(c);
  const { action, mark, markDetail, artifacts } = await applyMergeMarker({
    issue,
    op,
    ...(body.target ? { target: body.target } : {}),
    ...(body.note ? { note: body.note } : {}),
    ...(body.commit ? { commit: body.commit } : {}),
    ...(body.landing ? { landing: body.landing } : {}),
    ...(body.artifacts ? { artifacts: body.artifacts } : {}),
    ...(body.changedPaths ? { changedPaths: body.changedPaths } : {}),
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
  return c.json({ id: issueId, action, mark, detail: markDetail, artifacts });
}

const mergeMarkerValidators = [
  zValidator('param', idParamSchema),
  zValidator('json', mergeMarkerBodySchema),
] as const;

issueMergeRoutes.post('/:id/merge', ...mergeMarkerValidators, (c) => runMergeMarker(c, 'mark'));
issueMergeRoutes.delete('/:id/merge', ...mergeMarkerValidators, (c) => runMergeMarker(c, 'unmark'));
