import { VISUAL_BLOCK_KINDS } from '@forge/contracts/visual-blocks';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { attachVisualBlock } from './blocks.js';
import { reportsPorts } from './ports.js';
import { refuse, runReport } from './runs.js';

// The chat's two report tools, composed into the assistant's allowlist by the process entry
// (`mcp/chat-report-tools.ts`), so no assistant file names them: forge_report reads, forge_show
// draws. Data by code, look by blocks: a figure the model types never reaches a block.

const reportInput = z.strictObject({
  projectId: z.uuid(),
  queryId: z
    .string()
    .min(1)
    .max(64)
    .describe('a registered query id, as listed in this description'),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("the query's params; unknown keys are refused"),
});

const showInput = z.strictObject({
  projectId: z.uuid(),
  block: z
    .record(z.string(), z.unknown())
    .describe(
      "{ kind, ...the kind's fields, source: { runId } }; no frame: the run's is copied in",
    ),
});

const chatQueries = () =>
  reportsPorts()
    .listQueries()
    .filter((q) => q.surfaces.includes('chat'));

export const forgeReportTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_report',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description: `Runs one registered report query as the asker and keeps the run 30 days: answers { runId, queryId, version, params, asOf, frame }, the frame being fields and rows. Call it when the answer is figures, a progress, a roadmap, a release or a coverage, then draw the run with forge_show and state only figures the frame holds. Queries: ${chatQueries()
    .map((q) => `${q.id} (${q.title}; fields ${q.output.map((f) => f.name).join(', ')})`)
    .join('; ')}.`,
  inputSchema: zodToMcpSchema(reportInput),
  handler: async (args) => {
    const { projectId, queryId, params } = reportInput.parse(args);
    const userId = ctx.principal.userId;
    const access = await loadProjectAccess(projectId, userId);
    return runReport({
      projectId,
      queryId,
      params,
      asker: { userId, agency: principalAgency(ctx.principal), access },
      surface: 'chat',
    });
  },
});

export const forgeShowTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_show',
  reach: 'project',
  route: '/api/conversations',
  grant: 'assistant:write',
  description: `Draws one block of a forge_report run in this room, above your reply: ${VISUAL_BLOCK_KINDS.join(', ')}. block is { kind, source: { runId }, ...fields } where fields name the run's frame fields: table { columns, sort?: { field, dir }, limit? }; kpi { figures: [{ field, label, delta? }] 2-6, row? }; status-list { ref, status, waitingOn? }; chart { variant: bar|line|burndown, x, y: [field] }; timeline { label, start? end? | p50, p85, lane? }; flow { nodes: [{ id, label }], edges: [{ from, to, label? }] } with no source. A block holds no figure of its own: the run's frame is copied in, and a frame that differs from it is refused naming each figure. Answers the block's text, which your reply need not repeat.`,
  inputSchema: zodToMcpSchema(showInput),
  handler: async (args) => {
    const { projectId, block } = showInput.parse(args);
    const conversationId = ctx.turn?.conversationId;
    if (!conversationId) {
      throw refuse(
        'REPORT_BLOCK_NO_ROOM',
        'forge_show draws into the room a chat turn answers, and this call has none; an agent session posts a block over POST /api/conversations/:id/blocks',
        '/conversationId',
      );
    }
    return attachVisualBlock({
      conversationId,
      projectId,
      raw: block,
      asker: { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) },
    });
  },
});
