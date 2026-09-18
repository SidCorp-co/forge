/**
 * ISS-604 — build the MCP {@link McpContext} under which provider-chat tool
 * calls execute. The chat request is already user-authenticated and asserted
 * to be a project member, so we synthesize a PAT
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
    // cm:edge contract -> packages/core/src/middleware/pat-rest-surface.ts — null is the whole menu, and it is right here because this principal never crosses `beginPatRequest`: the chat surface synthesizes it after its own auth, so there is no granted token behind it to narrow by.
    permissions: null,
    // cm:guard `agent`, not `human` and not `null` — the PAT shape here is a carrier for the user's identity, not a claim that a person is typing, and the agent driving this surface IS established: it is core's own assistant, running in this process. Flipping it hands every chat write the human exemption from the ISS-812 fabrication guard, and nulling it says nothing was established when something was.
    agency: 'agent',
    // cm:guard `null` beside an `agent` agency, and the pair is not a contradiction: `agentUserId` names an agent ACCOUNT holding this credential, and the assistant holds none — it is core acting on a signed-in person's behalf. A value here would let this synthetic principal through the one door reserved for an agent speaking as itself (`POST /api/questions/:id/answer`, ISS-1003), which is exactly the borrowed authority that door refuses.
    agentUserId: null,
    // cm:guard `null`, and it may never become a device id. Chat runs in core's own process on behalf of a signed-in person, so it speaks for no box; a value here would let a synthetic principal through `requireDevice`-shaped checks that exist to gate a paired machine.
    deviceId: null,
    userId: opts.userId,
    tokenId: CHAT_TOKEN_ID,
    // cm:guard `read` and only `read` — read handlers such as forge_projects_get refuse a PAT without it (measured 2026-09-04: the allowlist offered the tool and every call failed FORBIDDEN_SCOPE), while `write` is deliberately absent because the allowlist's per-action gate, not the scope, is what bounds chat writes
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
