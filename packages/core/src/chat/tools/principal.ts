/**
 * ISS-604 — build the MCP {@link McpContext} under which provider-chat tool
 * calls execute. The chat request is already user-authenticated and asserted
 * to be a project member (see `chat/routes.ts`), so we synthesize a PAT
 * principal for that user, FENCED to the one project the session belongs to
 * (`boundProjectId` + a single-entry `projectIds` allowlist). Cross-project
 * reads therefore surface as NOT_FOUND via the standard membership fences.
 *
 * Read-only is enforced at the tool layer (the allowlist's per-tool action
 * filter in `mcp-adapter.ts`), NOT by the principal — the principal carries
 * the real user's membership so read handlers succeed.
 */

import type { Device } from '../../auth/deviceToken.js';
import type { McpContext } from '../../mcp/tools/lib.js';
import type { McpPrincipal } from '../../middleware/require-pat-or-device.js';

const CHAT_TOKEN_ID = '__chat_synthetic__';

/** Stub device row — mirrors `mcp/handler.ts stubDeviceForPat`; never hits the DB. */
function stubDevice(userId: string): Device {
  return {
    id: CHAT_TOKEN_ID,
    ownerId: userId,
    name: '__chat_synthetic__',
    platform: 'linux',
    agentVersion: null,
    tokenHash: '',
    tokenPrefix: '',
    status: 'online',
    disabledAt: null,
    lastSeenAt: null,
    pairedAt: new Date(0),
    capabilities: null,
    gitCredentialRef: null,
    machineId: null,
    createdAt: new Date(0),
  };
}

export function buildChatToolContext(opts: {
  userId: string;
  projectId: string;
  projectSlug: string;
}): McpContext {
  const principal: McpPrincipal = {
    kind: 'pat',
    userId: opts.userId,
    tokenId: CHAT_TOKEN_ID,
    scopes: [],
    projectIds: [opts.projectId],
    boundProjectId: opts.projectId,
  };
  return {
    principal,
    device: stubDevice(opts.userId),
    projectSlug: opts.projectSlug,
    boundProjectId: opts.projectId,
  };
}
