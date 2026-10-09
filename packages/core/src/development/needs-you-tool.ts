// The assistant's door to the needs-me read (REQ-41 BC-1, BC-2): the same function the route and the
// project home read, so "what waits on me" in chat and the page beside it cannot disagree.

import { NEEDS_YOU_DECISION_GROUP_LABELS } from '@forge/contracts/needs-you-decisions';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { requireHeld } from '../permissions/index.js';
import { readNeedsYouDecisions } from './needs-you-decisions.js';
import { needsYouViewerOf } from './needs-you-viewer.js';

export const NEEDS_YOU_TOOL = 'forge_needs_you';

const NEEDS_YOU_TOOL_LIMIT_DEFAULT = 20;
const NEEDS_YOU_TOOL_LIMIT_MAX = 50;

const input = z.strictObject({
  projectId: z.uuid(),
  limit: z.number().int().min(1).max(NEEDS_YOU_TOOL_LIMIT_MAX).optional(),
});

const groups = Object.entries(NEEDS_YOU_DECISION_GROUP_LABELS)
  .map(([g, label]) => `${g} (${label})`)
  .join(', ');

export const forgeNeedsYouTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: NEEDS_YOU_TOOL,
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description: `What waits on the person asking: ONLY the decisions they must make, the read the Needs you list and the project home draw. Call it for "what needs me", "what is waiting on me", "what should I decide". Each decision has its group (${groups}, in that order, oldest first), the record it opens, the question, the recommended answer with why and who recommended it (or noRecommendation saying why there is none), and its answers: the buttons the chat draws under your reply from this result, which the person presses themselves. \`total\` counts every decision, \`decisions\` holds the first \`limit\` (default ${NEEDS_YOU_TOOL_LIMIT_DEFAULT}). \`notDecisions\` counts the rows Needs you also lists that are not a decision, by reason (own_work: their own draft to finish; work: a task, not a choice; awaiting_proposal: a draft nobody proposed merging or dropping yet) — end the reply with one line naming what was left out, by reason and count.`,
  inputSchema: zodToMcpSchema(input),
  handler: async (args) => {
    const { projectId, limit } = input.parse(args);
    const userId = ctx.principal.userId;
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    const read = await readNeedsYouDecisions(
      projectId,
      needsYouViewerOf(access, userId, principalAgency(ctx.principal)),
    );
    return { ...read, decisions: read.decisions.slice(0, limit ?? NEEDS_YOU_TOOL_LIMIT_DEFAULT) };
  },
});
