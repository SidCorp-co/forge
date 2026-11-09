// `forge_project`: how one project stands, what waits on the caller and the decisions recorded, for a
// product owner, BA or project manager working from an MCP client (ISS-1183, REQ-78 BC-8). Each action
// runs the assistant's own read unchanged (`forge_project_status`, `forge_needs_you`,
// `forge_decisions`), so what a product role reads here and what the chat and the dashboard say
// cannot disagree. Reached as the `project.*` actions through forge_call.

import { PROJECT_TOOL_READS } from '@forge/contracts/mcp-product';
import { z } from 'zod';
import { forgeDecisionsTool } from '../comments/index.js';
import { forgeNeedsYouTool } from '../development/index.js';
import { RefusalError, requestRefusals } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { onArg } from '../permissions/index.js';
import { forgeProjectStatusTool } from '../project-status/index.js';

const input = z.strictObject({
  action: z.enum(PROJECT_TOOL_READS),
  projectId: z.uuid(),
  days: z.number().int().min(1).max(365).optional().describe('status, decisions: the last n days'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('needs_you, decisions: at most n rows'),
});

const SHAPE = '{ action, projectId, days?, limit? }';

const DESCRIPTION = `How one project stands, what waits on you and what was decided, read as the dashboard, Needs you and the Forge bot read them.
- status { projectId, days? }: how the project stands now: what is stuck, the decisions waiting on you, what shipped, work in flight, what members owe, requirements proven, the next release, what is late and the roadmap. Read it first for status, progress or what to do next.
- needs_you { projectId, limit? }: only the decisions waiting on you, each with its question, the recommended answer and why; \`notDecisions\` counts what else your Needs you list holds.
- decisions { projectId, days?, limit? }: the decisions recorded in the project, newest first, each on its issue, requirement, design or feedback item with the reason, who decided and when.`;

export const forgeProjectTool: ContextScopedMcpToolFactory = (ctx) => {
  const reads = {
    status: forgeProjectStatusTool(ctx),
    needs_you: forgeNeedsYouTool(ctx),
    decisions: forgeDecisionsTool(ctx),
  };
  return {
    name: 'forge_project',
    description: DESCRIPTION,
    inputSchema: zodToMcpSchema(input),
    route: '/api/projects',
    grant: 'projects:read',
    reach: 'project',
    permission: {
      byAction: {
        status: onArg('project.read'),
        needs_you: onArg('project.read'),
        decisions: onArg('project.read'),
      },
    },
    handler: async (args) => {
      const parsed = input.safeParse(args);
      if (!parsed.success) {
        throw new RefusalError(
          requestRefusals('BAD_REQUEST', SHAPE, parsed.error),
          'BAD_REQUEST',
          SHAPE,
        );
      }
      const { action, projectId, days, limit } = parsed.data;
      if (action === 'status') return reads.status.handler({ projectId, days });
      if (action === 'needs_you') return reads.needs_you.handler({ projectId, limit });
      return reads.decisions.handler({ projectId, days, limit });
    },
  };
};
