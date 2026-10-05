// The BA room a toolset is bound to, and what every BA tool shares: its JSON schema and its actor.

import { z } from 'zod';
import { principalAgency } from '../../issues/index.js';
import type { McpContext } from '../../lib/tool.js';

export interface BaRoom {
  projectId: string;
  requirementId: string;
}

export const schema = (s: z.ZodType) => z.toJSONSchema(s) as Record<string, unknown>;

export function actorOf(ctx: McpContext) {
  return { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) };
}
