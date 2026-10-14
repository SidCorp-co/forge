import { z } from 'zod';
import { listAgentSessionsForMcp, readAgentSession } from '../../agent-sessions/service.js';
import { agentSessionStatuses } from '../../db/session-vocabulary.js';
import {
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  zodToMcpSchema,
} from './lib.js';
import { buildListEnvelope, overfetch } from './list-envelope.js';

/**
 * MCP Phase 1 (ISS-7) — read-only access to the agent_sessions table.
 * Mirrors the cross-project list handler in
 * `packages/core/src/agent-sessions/routes.ts` (~line 684) but scopes to a
 * single project (the MCP caller passes `projectId` explicitly).
 */

const listInputSchema = z
  .object({
    projectId: z.uuid(),
    issueId: z.uuid().optional(),
    status: z.enum(agentSessionStatuses).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const getInputSchema = z.object({ sessionId: z.uuid() }).strict();

export const forgeAgentSessionsListTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_agent_sessions.list',
  description:
    'List agent sessions for a project. Optional issueId/status filters. Returns a lightweight projection per session: the heavy jsonb columns (messages transcript, diff, usage, pipelineTelemetry, pipelineHealth, pipelineControl) are OMITTED to stay under the response token cap — `messageCount` is the length of the session transcript itself, the same number `get` reports as `totalMessages`, and `0` means the session recorded nothing. `transcript` says whether core holds one: a `master` or `run_session` session runs in a box-local claude process and keeps no transcript here, so its `transcript` is `not-recorded` and its `messageCount` is `null`, which means "core was never told" and says nothing about how much work the session did; fetch the messages (last-20 tail) via forge_agent_sessions.get. EVERY list response carries `returned`, `limit` and `hasMore` — read `hasMore` before reporting a count as complete, because a list bound by your own limit is otherwise indistinguishable from a complete one. `truncated`/`truncatedBy` say which cap bit. Requires project membership.',
  inputSchema: zodToMcpSchema(listInputSchema),
  handler: async (args) => {
    const { projectId, issueId, status, limit } = listInputSchema.parse(args);
    await assertPrincipalIsMember(principal, projectId);

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
      hint: 'narrow with the status/issueId filters',
    });
  },
});

export const forgeAgentSessionsGetTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_agent_sessions.get',
  description:
    'Fetch a single agent session. Truncates `messages` to the last 20 entries (`totalMessages` is the length of the whole transcript and equals `messageCount`) so MCP payloads stay bounded. Both counts are `null` and `transcript` is `not-recorded` for a `master` or `run_session` session: its transcript is not in core, so `messages` is empty whatever the session did. Requires the principal to be a member of the session’s project; PAT principals must additionally have the session’s project in their allowlist.',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const { sessionId } = getInputSchema.parse(args);
    const row = await readAgentSession(sessionId);
    if (!row) throw new Error('NOT_FOUND: agent session not found');
    await assertPrincipalIsMember(principal, row.projectId);

    return { session: row };
  },
});
