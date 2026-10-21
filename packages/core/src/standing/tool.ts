// The standing read for an agent (REQ-48 BC-8): the same rows the route answers, so the chat, the
// steward and every screen read one standing.

import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { requireHeld } from '../permissions/index.js';
import { openStandings } from './read.js';

const input = z.strictObject({
  projectId: z.uuid(),
  stuckOnly: z.boolean().optional(),
});

export const forgeStandingTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_standing',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description:
    'Where every open requirement, feedback item and issue of the project stands, stuck first: its group, whom it waits on for what (waitingOn), since when (since), when that falls due (dueAt), whether it is stuck and why in one sentence (stuck: code no_owner, nobody_serves, draft_carrier, blocked or overdue, with reason and the issue it came via), the issue it was carried from (carriedBy), the basis a steward note is checked against, and its current steward note. Pass stuckOnly for the stuck rows alone. Quote stuck.reason as written.',
  inputSchema: zodToMcpSchema(input),
  handler: async (args) => {
    const { projectId, stuckOnly } = input.parse(args);
    requireHeld(await loadProjectAccess(projectId, ctx.principal.userId), 'project.read');
    const standings = await openStandings(projectId);
    return { standings: stuckOnly ? standings.filter((s) => s.stuck !== null) : standings };
  },
});
