/**
 * The record store, over REST. `issue_attributes` holds typed assertions with a
 * `source_comment_id` pointing back at the comment that made them, and the MCP
 * `forge_issues action=setAttributes` tool was its only door — no destination a REST writer could
 * be sent to, and a refusal naming a route nobody can reach teaches nothing. This route calls the
 * same service, so there is one writer and one set of refusals: every one of them is raised inside
 * `setIssueAttributes`, and all this route decides is which status carries which code.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../../lib/authz.js';
import type { AuthVars } from '../../middleware/auth.js';
import { loadIssueAttributes } from './read.js';
import { setIssueAttributes } from './service.js';
import { AttributeRefusal, type AttributeRefusalCode } from './write.js';

const idParamSchema = z.object({ id: z.uuid() });

const attributeSchema = z
  .object({
    key: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
    sourceCommentId: z.uuid().nullish(),
  })
  .strict();

const writeBodySchema = z.object({ attributes: z.array(attributeSchema).min(1).max(50) }).strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

/**
 * The status each refusal is rendered at. A drifted registry is the server's
 * own two lists disagreeing, which is a conflict and not the caller's input;
 * every other refusal names something the caller sent.
 */
const REFUSAL_STATUS: Record<AttributeRefusalCode, 400 | 409> = {
  UNREGISTERED_KEY: 400,
  WRONG_TYPE: 400,
  OBLIGATION_UNOWNED: 400,
  EMPTY_TEXT: 400,
  SOURCE_COMMENT_NOT_FOUND: 400,
  SOURCE_COMMENT_OFF_ISSUE: 400,
  ATTRIBUTE_DEF_MISSING: 409,
};

/** The HTTP an attribute refusal becomes, carrying its own code by name. */
function refusalHttp(err: AttributeRefusal): HTTPException {
  const cause: { code: string; details?: unknown } = { code: err.code };
  if (err.details !== undefined) cause.details = err.details;
  return new HTTPException(REFUSAL_STATUS[err.code], { message: err.message, cause });
}

export function registerIssueAttributeRoutes(router: Hono<{ Variables: AuthVars }>): void {
  router.post(
    '/:id/attributes',
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    zValidator('json', writeBodySchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    async (c) => {
      const { id: issueId } = c.req.valid('param');
      const { attributes } = c.req.valid('json');
      const issue = await loadIssueRow(issueId);
      const access = await loadProjectAccess(issue.projectId, c.get('userId'));
      assertProjectRole(access, 'member');

      try {
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
      } catch (err) {
        if (err instanceof AttributeRefusal) throw refusalHttp(err);
        throw err;
      }
    },
  );

  router.get(
    '/:id/attributes',
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    async (c) => {
      const { id: issueId } = c.req.valid('param');
      const issue = await loadIssueRow(issueId);
      const access = await loadProjectAccess(issue.projectId, c.get('userId'));
      assertProjectRole(access, 'viewer');
      return c.json({ attributes: await loadIssueAttributes(issue.id) });
    },
  );
}

async function loadIssueRow(issueId: string): Promise<{ id: string; projectId: string }> {
  const [row] = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) throw notFound('issue not found');
  return row;
}
