import {
  ComputeRequestSchema,
  EXECUTION_IO,
  EXECUTION_TURN_CAPS,
} from '@forge/contracts/report-executions';
import { VISUAL_BLOCK_KINDS } from '@forge/contracts/visual-blocks';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from '../lib/tool.js';
import { attachVisualBlock } from './blocks.js';
import { computeExecution } from './compute.js';
import { refuseExecution } from './executors.js';
import { reportsPorts } from './ports.js';
import { refuse, runReport } from './runs.js';
import { checkTemplateNarrative, listReportTemplates, runTemplate } from './templates.js';

// The chat's report tools, composed into the assistant's allowlist by the process entry
// (`mcp/chat-report-tools.ts`), so no assistant file names them: forge_report reads, forge_show
// draws, forge_template runs a template and forge_compute runs a script over this turn's runs. Data
// by code, look by blocks: a figure the model types never reaches a block.

// the runs this turn made, which forge_compute may read: one turn builds its toolset once over one
// context, so the context is the turn
const turnRuns = new WeakMap<McpContext, Set<string>>();
const runsOf = (ctx: McpContext): Set<string> => {
  const held = turnRuns.get(ctx) ?? new Set<string>();
  turnRuns.set(ctx, held);
  return held;
};

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
      "{ kind, ...the kind's fields, source: { runId } | { executionId, frame? } }; no frame: the source's is copied in",
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
    const run = await runReport({
      projectId,
      queryId,
      params,
      asker: { userId, agency: principalAgency(ctx.principal), access },
      surface: 'chat',
    });
    runsOf(ctx).add(run.runId);
    return run;
  },
});

export const forgeShowTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_show',
  reach: 'project',
  route: '/api/conversations',
  grant: 'assistant:write',
  description: `Draws one block of a forge_report run in this room, above your reply: ${VISUAL_BLOCK_KINDS.join(', ')}. block is { kind, source: { runId } or forge_compute's { executionId, frame? }, ...fields } where fields name the frame's fields: table { columns, sort?: { field, dir }, limit? }; kpi { figures: [{ field, label, delta? }] 2-6, row? }; status-list { ref, status, waitingOn? }; chart { variant: bar|line|burndown, x, y: [field] }; timeline { label, start? end? | p50, p85, lane? }; flow { nodes: [{ id, label }], edges: [{ from, to, label? }] } with no source. A block holds no figure of its own: the run's frame is copied in, a frame that differs from it is refused naming each figure, and so is a title or label stating a number the run does not hold. The block is held with your reply and shown above it only once the reply passes the reply check; if the reply has to be rewritten, only the blocks the rewrite draws again are shown. Answers the block's text, which your reply need not repeat.`,
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
    const stage = ctx.turn?.blockStage;
    if (!stage) {
      throw refuse(
        'REPORT_BLOCK_TURN_DOOR',
        `this chat turn holds no stage for a block, so nothing could hold it until its reply is checked: only a turn in a Forge web room draws blocks (conversation ${conversationId}); state the figures of the run in the reply instead`,
        '/conversationId',
      );
    }
    return attachVisualBlock({
      conversationId,
      projectId,
      raw: block,
      asker: { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) },
      stage,
    });
  },
});

const templateInput = z.strictObject({
  projectId: z.uuid(),
  templateId: z.string().min(1).max(64).describe('a template id, as listed in this description'),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("the template's params; unknown names are refused"),
  runIds: z
    .array(z.string().min(1).max(64))
    .max(12)
    .optional()
    .describe(
      "with narrative: the run of each of the template's queries, in order, as the first call returned them",
    ),
  narrative: z
    .strictObject({
      summary: z.string().optional(),
      risks: z.string().optional(),
      recommendations: z.string().optional(),
    })
    .optional()
    .describe('your slots, to be checked against those runs before you state them'),
});

export const forgeTemplateTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_template',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description: `Runs a report template as the asker: ${listReportTemplates()
    .map(
      (t) => `${t.id} (${t.title}${t.params.length > 0 ? `; params ${t.params.join(', ')}` : ''})`,
    )
    .join(
      '; ',
    )}. Answers { document: { runs, blocks }, slots, notDrawn } and keeps each run 30 days. Draw each block with forge_show (source its run), then write each slot from document.runs alone. Before you state the slots, call again with runIds and narrative: a slot over its words, or a figure no run returned, is refused by name.`,
  inputSchema: zodToMcpSchema(templateInput),
  handler: async (args) => {
    const input = templateInput.parse(args);
    const userId = ctx.principal.userId;
    const agency = principalAgency(ctx.principal);
    if (input.narrative !== undefined) {
      if (input.runIds === undefined) {
        throw refuse(
          'REPORT_TEMPLATE_RUNS_MISMATCH',
          "a narrative is checked against the runs it cites; give runIds, the run of each of the template's queries in order, as the first call returned them",
          '/runIds',
        );
      }
      return checkTemplateNarrative({
        projectId: input.projectId,
        templateId: input.templateId,
        runIds: input.runIds,
        narrative: input.narrative,
        userId,
        agency,
      });
    }
    const output = await runTemplate({
      projectId: input.projectId,
      templateId: input.templateId,
      params: input.params,
      asker: { userId, agency, access: await loadProjectAccess(input.projectId, userId) },
      surface: 'chat',
    });
    for (const run of output.document.runs) runsOf(ctx).add(run.runId);
    return output;
  },
});

const computeInput = z.strictObject({
  projectId: z.uuid(),
  ...ComputeRequestSchema.shape,
});

export const forgeComputeTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_compute',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:write',
  description: `Runs a short python or bash script in an isolated sandbox with no network, over the frames of report runs THIS turn made (inputs: their runIds), only where no report query answers. ${EXECUTION_IO}. A turn may run ${EXECUTION_TURN_CAPS.calls} executions and ${EXECUTION_TURN_CAPS.wallMs} ms in all. Answers { executionId, exit, stopped?, frames, logs, error? }; draw a frame with forge_show source { executionId, frame? }, labelled computed; show the script and its result, and act on it only once the person confirms.`,
  inputSchema: zodToMcpSchema(computeInput),
  handler: async (args) => {
    const { projectId, ...request } = computeInput.parse(args);
    const conversationId = ctx.turn?.conversationId;
    if (!conversationId) {
      throw refuseExecution(
        'EXECUTION_DOOR_FORBIDDEN',
        'forge_compute runs for the room a chat turn answers, and this call has none; an agent session runs a computation over POST /api/projects/:id/executions',
        '/conversationId',
      );
    }
    const userId = ctx.principal.userId;
    return computeExecution({
      projectId,
      request,
      asker: {
        userId,
        agency: principalAgency(ctx.principal),
        access: await loadProjectAccess(projectId, userId),
      },
      door: {
        kind: 'chat',
        conversationId,
        turnKey: `token:${ctx.principal.tokenId}`,
        turnRuns: runsOf(ctx),
      },
    });
  },
});
