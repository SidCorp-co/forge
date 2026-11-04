// The BA room a toolset is bound to, and what every BA tool shares: its JSON schema and its actor.

import { z } from 'zod';
import { principalAgency } from '../../issues/index.js';
import { loadProjectAccess } from '../../lib/authz.js';
import type { McpContext } from '../../lib/tool.js';
import { onResolved, requireDeclared } from '../../permissions/index.js';

export interface BaRoom {
  projectId: string;
  requirementId: string;
}

export const schema = (s: z.ZodType) => z.toJSONSchema(s) as Record<string, unknown>;

export function actorOf(ctx: McpContext) {
  return { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) };
}

const THE_ROOM = 'the project of the BA room the turn answers in';

/** What a BA tool declares (ISS-947): a permission on the room's project, which its handler or the service it calls checks. */
export const inRoom = (permission: 'project.read' | 'project.write') =>
  onResolved(permission, THE_ROOM);

/** The declared permission held on the room's project, for a BA tool whose service checks none itself. */
export async function requireInRoom(ctx: McpContext, projectId: string): Promise<void> {
  requireDeclared(await loadProjectAccess(projectId, ctx.principal.userId));
}
