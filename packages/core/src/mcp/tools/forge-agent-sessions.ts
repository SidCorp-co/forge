import { type SQL, and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { agentSessionStatuses, agentSessions } from '../../db/schema.js';
import {
  type DeviceScopedMcpToolFactory,
  assertDeviceOwnerIsMember,
  zodToMcpSchema,
} from './lib.js';

/**
 * MCP Phase 1 (ISS-7) — read-only access to the agent_sessions table.
 * Mirrors the cross-project list handler in
 * `packages/core/src/agent-sessions/routes.ts` (~line 684) but scopes to a
 * single project (the MCP caller passes `projectId` explicitly).
 */

const MESSAGE_TAIL = 20;

const listInputSchema = z
  .object({
    projectId: z.uuid(),
    issueId: z.uuid().optional(),
    status: z.enum(agentSessionStatuses).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const getInputSchema = z.object({ sessionId: z.uuid() }).strict();

export const forgeAgentSessionsListTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_agent_sessions.list',
  description:
    'List agent sessions for a project. Optional issueId/status filters. Requires device owner to be a project member.',
  inputSchema: zodToMcpSchema(listInputSchema),
  handler: async (args) => {
    const { projectId, issueId, status, limit } = listInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, projectId);

    const conds: SQL[] = [eq(agentSessions.projectId, projectId)];
    if (status) conds.push(eq(agentSessions.status, status));
    if (issueId) {
      conds.push(sql`${agentSessions.metadata}->>'issueId' = ${issueId}`);
    }

    const rows = await db
      .select()
      .from(agentSessions)
      .where(and(...conds))
      .orderBy(desc(agentSessions.updatedAt))
      .limit(limit ?? 50);

    return { sessions: rows };
  },
});

export const forgeAgentSessionsGetTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_agent_sessions.get',
  description:
    'Fetch a single agent session. Truncates `messages` to the last 20 entries (totalMessages exposes the full count) so MCP payloads stay bounded. Requires device owner to be a member of the session’s project.',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const { sessionId } = getInputSchema.parse(args);
    const [row] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    if (!row) throw new Error('NOT_FOUND: agent session not found');
    await assertDeviceOwnerIsMember(device, row.projectId);

    const allMessages = Array.isArray(row.messages) ? (row.messages as unknown[]) : [];
    const truncated = allMessages.slice(-MESSAGE_TAIL);
    return {
      session: {
        ...row,
        messages: truncated,
        totalMessages: allMessages.length,
      },
    };
  },
});
