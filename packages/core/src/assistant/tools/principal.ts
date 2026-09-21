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
