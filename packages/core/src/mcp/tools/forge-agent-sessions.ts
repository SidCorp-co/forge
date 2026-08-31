import { z } from 'zod';
import { listAgentSessionsForMcp, readAgentSession } from '../../agent-sessions/service.js';
import { agentSessionStatuses } from '../../db/schema.js';
import {
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  type DeviceScopedMcpToolFactory,
  zodToMcpSchema,
} from './lib.js';
import { buildListEnvelope, overfetch } from './list-envelope.js';
import { assertDeviceOwnerIsMember } from './project-authz.js';

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
    'List agent sessions for a project. Optional issueId/status filters. Returns a lightweight projection per session: the heavy jsonb columns (messages transcript, diff, usage, pipelineTelemetry, pipelineHealth, pipelineControl) are OMITTED to stay under the response token cap — `messageCount` exposes the transcript length; fetch the messages (last-20 tail) via forge_agent_sessions.get. EVERY list response carries `returned`, `limit` and `hasMore` — read `hasMore` before reporting a count as complete, because a list bound by your own limit is otherwise indistinguishable from a complete one. `truncated`/`truncatedBy` say which cap bit. Requires device owner to be a project member.',
  inputSchema: zodToMcpSchema(listInputSchema),
  handler: async (args) => {
    const { projectId, issueId, status, limit } = listInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, projectId);

    const sessionsLimit = limit ?? 50;
    const rows = await listAgentSessionsForMcp({
      projectId,
      status,
      issueId,
      limit: overfetch(sessionsLimit),
    });

    return buildListEnvelope({
      key: 'sessions',
      items: rows,
      limit: sessionsLimit,
      hint: 'narrow with status/issueId/jobId filters',
    });
  },
});

export const forgeAgentSessionsGetTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_agent_sessions.get',
  description:
    'Fetch a single agent session. Truncates `messages` to the last 20 entries (totalMessages exposes the full count) so MCP payloads stay bounded. Requires the principal to be a member of the session’s project; PAT principals must additionally have the session’s project in their allowlist.',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const { sessionId } = getInputSchema.parse(args);
    const row = await readAgentSession(sessionId);
    if (!row) throw new Error('NOT_FOUND: agent session not found');
    await assertPrincipalIsMember(principal, row.projectId);

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
