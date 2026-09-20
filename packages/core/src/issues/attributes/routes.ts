/**
 * The record store, over REST.
 *
 * `issue_attributes` held typed assertions with a `source_comment_id` pointing
 * back at the comment that made them, and the only door onto it was the
 * `forge_issues action=setAttributes` MCP tool. The writer that serialises
 * records into comment bodies is a REST caller, so it had no destination to be
 * sent to — a refusal naming a route nobody can reach teaches nothing. This is
 * that route, over the same service the MCP tool calls, so there is one writer
 * and one set of refusals.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { pgConstraintName, pgErrorCode } from '../../comments/error-mapping.js';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../../lib/authz.js';
import type { AuthVars } from '../../middleware/auth.js';
import { loadIssueAttributes } from './read.js';
import { setIssueAttributes } from './service.js';
import { AttributeRefusal } from './write.js';

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

/** The 400 an attribute refusal becomes, carrying its own code by name. */
function refusalHttp(err: AttributeRefusal): HTTPException {
  return new HTTPException(400, { message: err.message, cause: { code: err.code } });
}

const DEFS_FK = 'issue_attributes_key_issue_attribute_defs_key_fk';

/**
 * The drift between the two copies of the key list, said in words.
 *
 * `ATTRIBUTE_REGISTRY` validates the write and the `issue_attribute_defs`
 * seed in migration 0245 carries the foreign key, and the two are kept in step
 * by hand. A key one holds and the other does not passes validation and then
 * breaks on the constraint — which reached the caller as a 500 naming a
 * Postgres constraint, and reaches a log as an unhandled error. Named here
 * instead, because an operator told the two registries have drifted can fix it
 * and one told `500` cannot.
 */
function driftHttp(keys: readonly string[]): HTTPException {
  return new HTTPException(409, {
    message: `no row in \`issue_attribute_defs\` for ${keys.map((k) => `\`${k}\``).join(', ')}, although this build's ATTRIBUTE_REGISTRY declares it — the code registry and the migration seed have drifted, and no write can land until they agree.`,
    cause: { code: 'ATTRIBUTE_DEF_MISSING', details: { keys } },
  });
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
        if (pgErrorCode(err) === '23503' && pgConstraintName(err) === DEFS_FK) {
          throw driftHttp(attributes.map((a) => a.key));
        }
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
