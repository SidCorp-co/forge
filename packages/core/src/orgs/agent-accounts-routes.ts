/**
 * The org-admin surface for Agent Access Tokens (ISS-932).
 *
 * Mounted onto `orgRoutes`, which already carries `requireAuth()` +
 * `assertEmailVerified()` for every path under `/api/orgs`; a separate file
 * only because the parent had reached its size budget.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { projectMemberRoles } from '../db/schema.js';
import { assertOrgAccess } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import { createAgentAccount, listAgentAccounts, revokeAgentAccount } from './agent-accounts.js';

export const agentAccountRoutes = new Hono<{ Variables: AuthVars }>();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message = 'not found') =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const orgParamSchema = z.object({ orgId: z.uuid() });

// cm:edge contract -> packages/core/src/middleware/pat-rest-surface.ts — `/api/orgs` is absent from `PAT_ALLOWED_PREFIXES`, and that absence IS the guard that an agent cannot mint another agent. These three routes gate on `assertOrgAccess(..., 'admin')`, which an agent's own membership (`member`) already fails; the allowlist is the second, earlier refusal and the one that survives somebody widening a role by mistake. Adding `/api/orgs` there hands every AAT the mint route.
const agentParamSchema = z.object({ orgId: z.uuid(), agentUserId: z.uuid() });

const createAgentSchema = z
  .object({
    handle: z.string().trim().toLowerCase(),
    projectId: z.uuid(),
    projectRole: z.enum(projectMemberRoles).optional(),
  })
  .strict();

agentAccountRoutes.get(
  '/:orgId/agents',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    await assertOrgAccess(orgId, c.get('userId'), 'admin');
    return c.json({ agents: await listAgentAccounts(orgId) });
  },
);

agentAccountRoutes.post(
  '/:orgId/agents',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', createAgentSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const body = c.req.valid('json');
    await assertOrgAccess(orgId, c.get('userId'), 'admin');

    const { agent, plaintext } = await createAgentAccount({
      orgId,
      projectId: body.projectId,
      handle: body.handle,
      ...(body.projectRole ? { projectRole: body.projectRole } : {}),
    });
    return c.json({ ...agent, plaintext }, 201);
  },
);

agentAccountRoutes.delete(
  '/:orgId/agents/:agentUserId',
  zValidator('param', agentParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId, agentUserId } = c.req.valid('param');
    await assertOrgAccess(orgId, c.get('userId'), 'admin');
    if (!(await revokeAgentAccount(orgId, agentUserId))) throw notFound('agent not found');
    return c.body(null, 204);
  },
);
