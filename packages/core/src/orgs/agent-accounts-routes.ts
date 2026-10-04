/**
 * The org-admin surface for Agent Access Tokens (ISS-932).
 *
 * Mounted onto `orgRoutes`, which already carries `requireAuth()` +
 * `assertEmailVerified()` for every path under `/api/orgs`; a separate file
 * only because the parent had reached its size budget.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { writeAssistantPreferences } from '../preferences/index.js';
import { answerStyles, projectMemberRoles } from '../db/schema.js';
import type { AuthVars } from '../middleware/auth.js';
import { assertMayMintFullCredential, mintEpochFor } from '../middleware/pat-rest-surface.js';
import { zValidator } from '../middleware/zod-validator.js';
import {
  createAgentAccount,
  listAgentAccounts,
  mintAgentCredential,
  revokeAgentAccount,
  revokeAgentCredentials,
  setAgentDisplayName,
  setAgentProjects,
} from './agent-accounts.js';
import { agentSelfPatchSchema, readAgentSelf, writeAgentSelf } from './agent-selves.js';
import { orgMemberRole } from './read.js';
import { actorFor, orgResource, requireOrgCan } from '../permissions/index.js';

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

const agentProjectsSchema = z.array(z.uuid()).min(1).max(50);

const createAgentSchema = z
  .object({
    handle: z.string().trim().toLowerCase(),
    projectIds: agentProjectsSchema,
    projectRole: z.enum(projectMemberRoles).optional(),
  })
  .strict();

const setAgentProjectsSchema = z.object({ projectIds: agentProjectsSchema }).strict();

agentAccountRoutes.get(
  '/:orgId/agents',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
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
    await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
    assertMayMintFullCredential(c);

    const { agent, plaintext } = await createAgentAccount({
      orgId,
      grantEpoch: mintEpochFor(c),
      projectIds: body.projectIds,
      handle: body.handle,
      ...(body.projectRole ? { projectRole: body.projectRole } : {}),
    });
    return c.json({ ...agent, plaintext }, 201);
  },
);

agentAccountRoutes.put(
  '/:orgId/agents/:agentUserId/projects',
  zValidator('param', agentParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', setAgentProjectsSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId, agentUserId } = c.req.valid('param');
    await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
    const out = await setAgentProjects(orgId, agentUserId, c.req.valid('json').projectIds);
    if (!out) throw notFound('agent not found');
    return c.json(out);
  },
);

agentAccountRoutes.delete(
  '/:orgId/agents/:agentUserId',
  zValidator('param', agentParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId, agentUserId } = c.req.valid('param');
    await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
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
    await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
    assertMayMintFullCredential(c);
    const minted = await mintAgentCredential(orgId, agentUserId, mintEpochFor(c));
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
    await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
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
    await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
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
    await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
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
    await requireOrgCan(actorFor(actor), 'org.admin', orgResource(orgId));
    const self = await writeAgentSelf(orgId, agentUserId, c.req.valid('json'), actor);
    if (!self) throw notFound('agent not found');
    return c.json(self);
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
    await requireOrgCan(actorFor(actor), 'org.admin', orgResource(orgId));
    if ((await orgMemberRole(orgId, userId)) === null) throw notFound('membership not found');
    const prefs = await writeAssistantPreferences({
      userId,
      patch: c.req.valid('json'),
      actor: { kind: 'admin', userId: actor },
    });
    return c.json(prefs);
  },
);
