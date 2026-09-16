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
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
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
