/**
 * Agent-session reads a project-scoped token can actually reach.
 *
 * `GET /api/agent-sessions` serves the same rows, but its no-`projectId`
 * branch fans out across every project the caller can see — which is why the
 * prefix is off the PAT allowlist and why `requireUserOrDevice`, which guards
 * it, has no PAT branch to add safely. These are the halves that name their
 * project in the path, so the PAT fence has something to check.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { agentSessionStatuses } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { buildListEnvelope, overfetch } from '../mcp/tools/list-envelope.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { listAgentSessionsForMcp, readAgentSession } from './service.js';

const paramSchema = z.object({ id: z.uuid() });
const sessionParamSchema = z.object({ id: z.uuid(), sessionId: z.uuid() });

const listQuerySchema = z.object({
  issueId: z.uuid().optional(),
  status: z.enum(agentSessionStatuses).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const agentSessionProjectReadRoutes = new Hono<{ Variables: AuthVars }>();
agentSessionProjectReadRoutes.use('/:id/agent-sessions', requireAuth(), assertEmailVerified());
agentSessionProjectReadRoutes.use(
  '/:id/agent-sessions/:sessionId',
  requireAuth(),
  assertEmailVerified(),
);

async function assertMember(projectId: string, userId: string): Promise<void> {
  const access = await loadProjectAccess(projectId, userId);
  assertProjectRole(access, 'viewer', 'not a project member');
}

agentSessionProjectReadRoutes.get(
  '/:id/agent-sessions',
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { issueId, status, limit } = c.req.valid('query');
    await assertMember(id, c.get('userId'));

    const rows = await listAgentSessionsForMcp({
      projectId: id,
      status,
      issueId,
      limit: overfetch(limit),
    });

    return c.json(
      buildListEnvelope({
        key: 'sessions',
        items: rows,
        limit,
        hint: 'narrow with status/issueId filters',
      }),
    );
  },
);

agentSessionProjectReadRoutes.get(
  '/:id/agent-sessions/:sessionId',
  zValidator('param', sessionParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id, sessionId } = c.req.valid('param');
    await assertMember(id, c.get('userId'));

    const row = await readAgentSession(sessionId);
    if (!row || row.projectId !== id) {
      throw new HTTPException(404, {
        message: 'agent session not found',
        cause: { code: 'NOT_FOUND' },
      });
    }

    return c.json({ session: row });
  },
);
