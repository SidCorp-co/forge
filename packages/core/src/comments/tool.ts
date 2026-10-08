import { COMMENT_SCOPES, DECISION_MAKERS } from '@forge/contracts/comments';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { MCP_DOOR } from '../lib/data-egress.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { listDecisionsAs } from './entity-read.js';

const DAY_MS = 86_400_000;
const DECISIONS_TOOL_MAX = 100;

const ref = z.string().trim().min(1).max(200);

const input = z.strictObject({
  projectId: z.uuid(),
  scope: z.enum(COMMENT_SCOPES).optional(),
  requirement: ref.optional(),
  workflow: ref.optional(),
  issue: ref.optional(),
  who: z.uuid().optional(),
  days: z.number().int().min(1).max(365).optional(),
  limit: z.number().int().min(1).max(DECISIONS_TOOL_MAX).optional(),
  by: z.enum(DECISION_MAKERS).optional(),
});

export const forgeDecisionsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_decisions',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description: `The decisions recorded in this project, newest first: each on an issue, requirement, workflow design or feedback item, with what was decided, the reason, who decided and when. Optional \`scope\` (${COMMENT_SCOPES.join(' | ')}), \`days\` (only decisions made in the last n days), \`by\` (${DECISION_MAKERS.join(' | ')}: a person's, an agent's or both; all by default here) and \`limit\` (1..${DECISIONS_TOOL_MAX}, default 30). A settled point written only in a requirement's prose is not a decision record and is not here.`,
  inputSchema: zodToMcpSchema(input),
  handler: async (args) => {
    const { projectId, days, limit, by, ...narrow } = input.parse(args);
    const read = await listDecisionsAs(
      { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) },
      projectId,
      {
        ...narrow,
        by: by ?? 'all',
        limit: limit ?? 30,
        ...(days ? { since: new Date(Date.now() - days * DAY_MS).toISOString() } : {}),
      },
      MCP_DOOR,
    );
    const decisions = read.decisions.map((d) => ({
      on: d.target,
      decision: d.decision,
      body: d.body,
      by: d.author,
      at: d.createdAt,
    }));
    return { decisions, returned: decisions.length, limit: read.limit, by: read.by };
  },
});
