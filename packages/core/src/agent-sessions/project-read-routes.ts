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
import { agentSessionStatuses } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { buildListEnvelope, overfetch } from '../lib/list-envelope.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { holds, requireHeld } from '../permissions/index.js';
import { listAgentSessionsForMcp, readAgentSession } from './read.js';
import { assertAgentChatOwner } from './session-access.js';

const paramSchema = z.object({ id: z.uuid() });
const sessionParamSchema = z.object({ id: z.uuid(), sessionId: z.uuid() });

const listQuerySchema = z.object({
  issueId: z.uuid().optional(),
  status: z.enum(agentSessionStatuses).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const agentSessionProjectReadRoutes = new Hono<{ Variables: AuthVars }>();
agentSessionProjectReadRoutes.use('/:id/agent-sessions', requireAuth(), assertEmailVerified());
agentSessionProjectReadRoutes.use(
  '/:id/agent-sessions/:sessionId',
  requireAuth(),
  assertEmailVerified(),
);

async function assertMember(projectId: string, userId: string) {
  const access = await loadProjectAccess(projectId, userId);
  requireHeld(access, 'project.read');
  return access;
}

agentSessionProjectReadRoutes.get(
  '/:id/agent-sessions',
  zValidator('param', paramSchema),
  zValidator('query', listQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { issueId, status, limit } = c.req.valid('query');
    const userId = c.get('userId');
    const access = await assertMember(id, userId);

    const rows = await listAgentSessionsForMcp({
      projectId: id,
      status,
      issueId,
      privateChatsOf: holds(access, 'project.admin') ? null : userId,
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
  zValidator('param', sessionParamSchema),
  async (c) => {
    const { id, sessionId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await assertMember(id, userId);

    const row = await readAgentSession(sessionId);
    if (!row || row.projectId !== id) {
      throw new HTTPException(404, {
        message: 'agent session not found',
        cause: { code: 'NOT_FOUND' },
      });
    }
    assertAgentChatOwner(row, access, userId);

    return c.json({ session: row });
  },
);
