/**
 * Agent-session reads a project-scoped token can actually reach.
 *
 * `GET /api/agent-sessions` serves the same rows, but its no-`projectId`
 * branch fans out across every project the caller can see — which is why the
 * prefix is off the PAT allowlist and why `requireUserOrDevice`, which guards
 * it, has no PAT branch to add safely. These are the halves that name their
 * project in the path, so the PAT fence has something to check.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { buildListEnvelope, overfetch } from '../mcp/tools/list-envelope.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import * as ref from './project-read-routes-reference.js';
import { listAgentSessionsForMcp, readAgentSession } from './service.js';

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
  ref.listProjectSessions,
  zValidator('param', ref.paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', ref.listQuerySchema, (r) => {
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
  ref.readProjectSession,
  zValidator('param', ref.sessionParamSchema, (r) => {
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

    return c.json(answer(ref.sessionDetailSchema, { session: row }));
  },
);
