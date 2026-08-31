import { z } from 'zod';
import { SteerError, steerIssue } from '../../agent-sessions/steer-session.js';
import { findIssueProjectId } from '../../issues/read-service.js';
import {
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  principalUserId,
  zodToMcpSchema,
} from './lib.js';

/**
 * ISS-888 item 2 — the MCP half of steer. An adapter over
 * `agent-sessions/steer-session.ts`, which REST `POST /api/issues/:id/steer`
 * also calls: one data plane, two doors (ISS-889).
 *
 * This is what lets ONE AGENT redirect another mid-run, which is the half a
 * REST endpoint alone cannot serve.
 */

const steerInputSchema = z
  .object({
    issueId: z.uuid(),
    body: z.string().trim().min(1).max(10_000),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const forgeSteerTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_steer',
  description:
    "Send new instruction to the agent ALREADY RUNNING this issue, without cancelling it — the text becomes that session's next turn. Reach for this the moment you see a live job going the wrong way: the alternative is letting it finish and re-running, which costs the remaining hours plus a whole job. Requires a duplex session that is WORKING: `SESSION_PARKED` means the agent asked a question and is waiting — answer it with a comment instead (forge_comments.create), which is the door that owns that case. `NO_LIVE_SESSION` means nothing is running this issue, so there is nothing to steer — use forge_issues.update to change what the NEXT job is told. The text is posted as a comment on the issue (that comment's id is the idempotency key) and the send is recorded as an audited intervention. Requires writer access (member/admin; PAT write scope).",
  inputSchema: zodToMcpSchema(steerInputSchema),
  handler: async (args) => {
    const { issueId, body, reason } = steerInputSchema.parse(args);
    const projectId = await findIssueProjectId(issueId);
    if (!projectId) throw new Error('NOT_FOUND: issue not found');
    await assertPrincipalIsWriter(principal, projectId);

    try {
      return await steerIssue(issueId, body, {
        actorUserId: principalUserId(principal),
        reason: reason ?? 'steer (MCP)',
        source: 'mcp',
      });
    } catch (e) {
      if (e instanceof SteerError) throw new Error(`${e.code}: ${e.message}`);
      throw e;
    }
  },
});
