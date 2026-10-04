/**
 * The record store, over REST. `issue_attributes` holds typed assertions with a
 * `source_comment_id` pointing back at the comment that made them. This route is their one door
 * and calls the service, so there is one writer and one set of refusals about what is written:
 * `setIssueAttributes` raises all of them, and the envelope answers them.
 * What a door still owns is its own shape — the body schema, the issue, the caller's role.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../../lib/authz.js';
import type { AuthVars } from '../../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../../middleware/route-errors.js';
import { zValidator } from '../../middleware/zod-validator.js';
import { requireHeld } from '../../permissions/index.js';
import { issueScopeOf } from '../read-service.js';
import { loadIssueAttributes } from './read.js';
import { setIssueAttributes } from './service.js';

const attributeSchema = z
  .object({
    key: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
    sourceCommentId: z.uuid().nullish(),
  })
  .strict();

const writeBodySchema = z.object({ attributes: z.array(attributeSchema).min(1).max(50) }).strict();

export function registerIssueAttributeRoutes(router: Hono<{ Variables: AuthVars }>): void {
  router.post(
    '/:id/attributes',
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw badRequest(r.error);
    }),
    zValidator('json', writeBodySchema, (r) => {
      if (!r.success) throw badRequest(r.error);
    }),
    async (c) => {
      const { id: issueId } = c.req.valid('param');
      const { attributes } = c.req.valid('json');
      const issue = await loadIssueRow(issueId);
      const access = await loadProjectAccess(issue.projectId, c.get('userId'));
      requireHeld(access, 'project.write');

      const result = await setIssueAttributes(
        attributes.map((a) => ({
          issueId: issue.id,
          key: a.key,
          value: a.value,
          sourceCommentId: a.sourceCommentId ?? null,
          assertedByUserId: c.get('userId'),
        })),
      );
      return c.json(result, 201);
    },
  );

  router.get(
    '/:id/attributes',
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw badRequest(r.error);
    }),
    async (c) => {
      const { id: issueId } = c.req.valid('param');
      const issue = await loadIssueRow(issueId);
      const access = await loadProjectAccess(issue.projectId, c.get('userId'));
      requireHeld(access, 'project.read');
      return c.json({ attributes: await loadIssueAttributes(issue.id) });
    },
  );
}

async function loadIssueRow(issueId: string): Promise<{ id: string; projectId: string }> {
  const row = await issueScopeOf(issueId);
  if (!row) throw notFound('issue not found');
  return { id: row.id, projectId: row.projectId };
}
