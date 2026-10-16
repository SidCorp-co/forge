// Who an MCP call acts as and reads for, in the shapes the product modules' services take: the door
// resolves them once from the token's principal, as REST resolves them from the request.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ForecastViewer } from '../forecast/index.js';
import { principalAgency } from '../issues/index.js';
import { loadProjectAccess, type ProjectAccess } from '../lib/authz.js';
import { type EgressReader, MCP_DOOR } from '../lib/data-egress.js';
import type { McpContext } from '../lib/tool.js';
import { holds, requireHeld } from '../permissions/index.js';

export interface DoorActor {
  userId: string;
  agency: ActorAgency;
}

export function actorOf(ctx: McpContext): DoorActor {
  return { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) };
}

/** The reader every product read passes the egress rule as: the MCP door is provider-bound. */
export function readerOf(ctx: McpContext): EgressReader {
  return { agency: principalAgency(ctx.principal), ...MCP_DOOR };
}

/** The caller's access to `projectId`, refused without project.read. */
export async function readAccess(ctx: McpContext, projectId: string): Promise<ProjectAccess> {
  const access = await loadProjectAccess(projectId, ctx.principal.userId);
  requireHeld(access, 'project.read');
  return access;
}

/** The forecast's reader: whose act a forecast's person leg names as You. */
export function forecastViewerOf(ctx: McpContext, access: ProjectAccess): ForecastViewer {
  return {
    userId: ctx.principal.userId,
    isAdmin: holds(access, 'project.admin'),
    mayApprove: holds(access, 'releases.approve'),
    canWrite: holds(access, 'project.write'),
  };
}
