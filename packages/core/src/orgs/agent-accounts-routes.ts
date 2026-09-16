/**
 * The org-admin surface for Agent Access Tokens (ISS-932).
 *
 * Mounted onto `orgRoutes`, which already carries `requireAuth()` +
 * `assertEmailVerified()` for every path under `/api/orgs`; a separate file
 * only because the parent had reached its size budget.
 */

import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { writeAssistantPreferences } from '../auth/preference-changes.js';
import { PresenceValidationError } from '../conversations/presence.js';
import { db } from '../db/client.js';
import { answerStyles, organizationMembers, projectMemberRoles } from '../db/schema.js';
import { assertOrgAccess } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import {
  createAgentAccount,
  listAgentAccounts,
  mintAgentCredential,
  revokeAgentAccount,
  revokeAgentCredentials,
  setAgentDisplayName,
} from './agent-accounts.js';
import { agentSelfPatchSchema, readAgentSelf, writeAgentSelf } from './agent-selves.js';

export const agentAccountRoutes = new Hono<{ Variables: AuthVars }>();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message = 'not found') =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const orgParamSchema = z.object({ orgId: z.uuid() });

const agentParamSchema = z.object({ orgId: z.uuid(), agentUserId: z.uuid() });

const displayNameSchema = z
  .object({ displayName: z.string().trim().min(1).max(200).nullable() })
  .strict();

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

agentAccountRoutes.post(
  '/:orgId/agents/:agentUserId/tokens',
  zValidator('param', agentParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId, agentUserId } = c.req.valid('param');
    await assertOrgAccess(orgId, c.get('userId'), 'admin');
    const minted = await mintAgentCredential(orgId, agentUserId);
    if (!minted) throw notFound('agent not found');
    return c.json(minted, 201);
  },
);

agentAccountRoutes.delete(
  '/:orgId/agents/:agentUserId/tokens',
  zValidator('param', agentParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId, agentUserId } = c.req.valid('param');
    await assertOrgAccess(orgId, c.get('userId'), 'admin');
    const revoked = await revokeAgentCredentials(orgId, agentUserId);
    if (revoked === null) throw notFound('agent not found');
    return c.json({ revoked });
  },
);

agentAccountRoutes.patch(
  '/:orgId/agents/:agentUserId',
  zValidator('param', agentParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', displayNameSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId, agentUserId } = c.req.valid('param');
    await assertOrgAccess(orgId, c.get('userId'), 'admin');
    const displayName = await setAgentDisplayName(
      orgId,
      agentUserId,
      c.req.valid('json').displayName,
    );
    if (displayName === undefined) throw notFound('agent not found');
    return c.json({ displayName });
  },
);

// ---------------------------------------------------------------------------
// The agent's SELF (ISS-1034): who it is, how it presents, how present it is.
// ---------------------------------------------------------------------------

agentAccountRoutes.get(
  '/:orgId/agents/:agentUserId/self',
  zValidator('param', agentParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId, agentUserId } = c.req.valid('param');
    await assertOrgAccess(orgId, c.get('userId'), 'admin');
    const self = await readAgentSelf(orgId, agentUserId);
    if (!self) throw notFound('agent not found');
    return c.json(self);
  },
);

agentAccountRoutes.patch(
  '/:orgId/agents/:agentUserId/self',
  zValidator('param', agentParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', agentSelfPatchSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId, agentUserId } = c.req.valid('param');
    const actor = c.get('userId');
    await assertOrgAccess(orgId, actor, 'admin');
    try {
      const self = await writeAgentSelf(orgId, agentUserId, c.req.valid('json'), actor);
      if (!self) throw notFound('agent not found');
      return c.json(self);
    } catch (err) {
      if (err instanceof PresenceValidationError) {
        throw new HTTPException(400, {
          message: err.message,
          cause: { code: 'PRESENCE_INVALID', issues: err.issues },
        });
      }
      throw err;
    }
  },
);

const memberParamSchema = z.object({ orgId: z.uuid(), userId: z.uuid() });

const memberAssistantPrefsSchema = z
  .object({
    answerStyle: z.enum(answerStyles).optional(),
    assistantInstructions: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((v) => v.answerStyle !== undefined || v.assistantInstructions !== undefined, {
    error: 'at least one of answerStyle/assistantInstructions is required',
  });

agentAccountRoutes.patch(
  '/:orgId/members/:userId/assistant-preferences',
  zValidator('param', memberParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', memberAssistantPrefsSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId, userId } = c.req.valid('param');
    const actor = c.get('userId');
    await assertOrgAccess(orgId, actor, 'admin');
    const [member] = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    if (!member) throw notFound('membership not found');
    const prefs = await writeAssistantPreferences({
      userId,
      patch: c.req.valid('json'),
      actor: { kind: 'admin', userId: actor },
    });
    return c.json(prefs);
  },
);
