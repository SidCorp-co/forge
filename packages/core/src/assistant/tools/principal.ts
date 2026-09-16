/**
 * ISS-604 — build the MCP {@link McpContext} under which provider-chat tool
 * calls execute. The chat request is already user-authenticated and asserted
 * to be a project member (see `assistant/routes.ts`), so we synthesize a PAT
 * principal for that user, FENCED to the one project the session belongs to
 * (`boundProjectId` + a single-entry `projectIds` allowlist). Cross-project
 * reads therefore surface as NOT_FOUND via the standard membership fences.
 *
 * Read-only is enforced at the tool layer (the allowlist's per-tool action
 * filter in `mcp-adapter.ts`), NOT by the principal — the principal carries
 * the real user's membership so read handlers succeed.
 */

import type { ChatTurnFacts, McpContext } from '../../mcp/tools/lib.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';

const CHAT_TOKEN_ID = '__chat_synthetic__';

export function buildChatToolContext(opts: {
  userId: string;
  projectId: string;
  projectSlug: string;
  /** The turn's room and linked speaker; omit on a turn that answers nobody in particular. */
  turn?: ChatTurnFacts | undefined;
}): McpContext {
  const principal: McpPrincipal = {
    kind: 'pat',
    permissions: null,
    agency: 'agent',
    agentUserId: null,
    deviceId: null,
    userId: opts.userId,
    tokenId: CHAT_TOKEN_ID,
    scopes: ['read'],
    projectIds: [opts.projectId],
    boundProjectId: opts.projectId,
  };
  return {
    principal,
    projectSlug: opts.projectSlug,
    boundProjectId: opts.projectId,
    ...(opts.turn ? { turn: opts.turn } : {}),
  };
}
