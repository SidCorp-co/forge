// `forge_project`: how one project stands, what waits on the caller and the decisions recorded, for a
// product owner, BA or project manager working from an MCP client (ISS-1183, REQ-78 BC-8). Each action
// runs the assistant's own read unchanged (`forge_project_status`, `forge_needs_you`,
// `forge_decisions`), so what a product role reads here and what the chat and the dashboard say
// cannot disagree. Reached as the `project.*` actions through forge_call.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import { PROJECT_TOOL_READS } from '@forge/contracts/mcp-product';
import { z } from 'zod';
import { forgeDecisionsTool } from '../comments/index.js';
import { forgeNeedsYouTool } from '../development/index.js';
import { RefusalError, requestRefusals } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, sourceOf, zodToMcpSchema } from '../lib/tool.js';
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

/** When a product role reaches for the project reads (ISS-1251), from how product roles used them. */
const CARDS = {
  status: {
    purpose: 'Reads how the project stands now, as its dashboard draws it.',
    situations: [
      {
        when: 'a person asks how the project is going, what is stuck, what shipped or what is next',
        do: 'read status first and answer from it, naming the read each figure came from',
      },
      {
        when: 'you start working a project’s Product and do not yet know where it stands',
        do: 'read status before any list, so your next step follows what is stuck or late',
      },
    ],
    practice: [
      'Say a forecast as the range it is; a release’s issues are releases.get’s, not this read’s.',
    ],
    example: { projectId: '<project uuid>', days: 7 },
    // ISS-1183: a product role answered "how does it stand" by walking issues.list and counting
    redFlag:
      'Counting issues.list by hand to say how the project stands: it disagrees with the dashboard.',
    family: 'product.status',
    audience: ['person'],
    scenarios: ['“how does it stand” answered by counting issues.list: ISS-1183'],
  },
  needs_you: {
    purpose: 'Lists only the decisions waiting on you, each with the recommended answer and why.',
    situations: [
      {
        when: 'a person asks what they owe, or what waits on them',
        do: 'read needs_you and put each decision with its recommended answer and why',
      },
      {
        when: 'you are about to ask a person something',
        do: 'read needs_you first: the decision may already wait on them with a recommendation',
      },
    ],
    practice: ['Answer each one on the item it shapes; notDecisions counts the rest of the list.'],
    example: { projectId: '<project uuid>', limit: 10 },
    redFlag:
      'Asking a person something without reading needs_you, when it already waits on them with a recommendation.',
    family: 'product.status',
    audience: ['person'],
    scenarios: ['a person asking what waits on them, answered from needs_you'],
  },
  decisions: {
    purpose: 'Reads the decisions recorded in the project, with who decided, when and why.',
    situations: [
      {
        when: 'a person asks why something was decided, or who decided it',
        do: 'read decisions over the days in question and quote the reason recorded',
      },
      {
        when: 'you are about to decide something that may already have been settled',
        do: 'read decisions first and follow or revise the one in force, never decide it twice',
      },
    ],
    practice: ['Quote the recorded reason and the item it sits on, not your reading of it.'],
    example: { projectId: '<project uuid>', days: 30, limit: 20 },
    redFlag:
      'Deciding again what decisions holds in force, or quoting your reading of it in place of its recorded reason.',
    family: 'product.status',
    audience: ['person'],
  },
} satisfies Record<(typeof PROJECT_TOOL_READS)[number], CapabilityCardBody>;

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
    cards: CARDS,
    source: sourceOf(import.meta.url),
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
