import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import pkg from '../../package.json' with { type: 'json' };
import { type AuditResultCode, digestArgs, writeMcpAudit } from '../auth/mcp-audit.js';
import { resolveManagedMetaPrompts } from '../skills/effective.js';
import { forgeMcpInstructions } from './instructions.js';
import { toToolCallContent } from './tool-result.js';
import {
  forgeAgentSessionsGetTool,
  forgeAgentSessionsListTool,
} from './tools/forge-agent-sessions.js';
import { forgeCollaboratorsTool } from './tools/forge-collaborators.js';
import { forgeCommentsTool } from './tools/forge-comments.js';
import { forgeConfigTool } from './tools/forge-config.js';
import { forgeCoolifyDeployTool } from './tools/forge-coolify-deploy.js';
import { forgeFeedbackTool } from './tools/forge-feedback.js';
import { forgeGithubTool } from './tools/forge-github.js';
import { forgeGoogleSheetsTool } from './tools/forge-google-sheets.js';
import { forgeGuideTool } from './tools/forge-guide.js';
import { forgeHealthTool } from './tools/forge-health.js';
import { forgeIssuesTool } from './tools/forge-issues.js';
import {
  forgeJobsCancelTool,
  forgeJobsEventsTool,
  forgeJobsGetTool,
  forgeJobsListTool,
  forgeJobsResumeTool,
} from './tools/forge-jobs.js';
import { forgeKnowledgeTool } from './tools/forge-knowledge.js';
import {
  forgeMemoryDeleteTool,
  forgeMemoryFeedbackTool,
  forgeMemoryGetTool,
  forgeMemorySearchTool,
  forgeMemoryWriteTool,
} from './tools/forge-memory.js';
import {
  forgeMetricsProjectRetryRescuesTool,
  forgeMetricsProjectStepDurationsTool,
  forgeMetricsProjectTimeseriesTool,
  forgeMetricsSessionFailuresTool,
} from './tools/forge-metrics.js';
import { forgeOrgsListTool, forgeOrgsMembersTool } from './tools/forge-orgs.js';
import { forgePhaseTool } from './tools/forge-phase.js';
import { forgePipelineRunsGetTool } from './tools/forge-pipeline-runs.js';
import { forgePmSetDependencyTool } from './tools/forge-pm-set-dependency.js';
import { forgeProjectPipelineRunsTool } from './tools/forge-project-pipeline-runs.js';
import { forgeProjectPmTool } from './tools/forge-project-pm.js';
import {
  forgeProjectsCreateTool,
  forgeProjectsGetTool,
  forgeProjectsListTool,
  forgeProjectsUpdateTool,
} from './tools/forge-projects.js';
import { forgeReconcileTool } from './tools/forge-reconcile.js';
import { forgeReleaseBatchTool } from './tools/forge-release-batch.js';
import { forgeRunnersTool } from './tools/forge-runners.js';
import { forgeSchedulesTool } from './tools/forge-schedules.js';
import { forgeSentryTool } from './tools/forge-sentry.js';
import { forgeSkillFactsGetTool, forgeSkillFactsListTool } from './tools/forge-skill-facts.js';
import {
  forgeSkillsAdoptTool,
  forgeSkillsCreateTool,
  forgeSkillsDeleteTool,
  forgeSkillsEffectiveTool,
  forgeSkillsGetTool,
  forgeSkillsListRegistrationsTool,
  forgeSkillsListTool,
  forgeSkillsPushTool,
  forgeSkillsRegisterTool,
  forgeSkillsSyncStatusTool,
  forgeSkillsUpdateTool,
} from './tools/forge-skills.js';
import {
  forgeStepHandoffDeleteTool,
  forgeStepHandoffGetTool,
  forgeStepHandoffWriteTool,
} from './tools/forge-step-handoff.js';
import { forgeStepStartTool } from './tools/forge-step-start.js';
import { forgeStorefrontTargetTool } from './tools/forge-storefront-target.js';
import { forgeUploadsTool } from './tools/forge-uploads.js';
import type { McpContext, McpTool } from './tools/lib.js';
import { patEffectiveProjectIds, resolveProjectIdFromSlug } from './tools/project-scope.js';

function classifyError(err: unknown): { code: AuditResultCode; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('NOT_FOUND')) return { code: 'not_found', message };
  if (message.startsWith('FORBIDDEN')) return { code: 'forbidden', message };
  return { code: 'error', message };
}

function projectIdFromArgs(args: Record<string, unknown>): string | null {
  const top = args.projectId;
  if (typeof top === 'string') return top;
  const filters = args.filters;
  if (filters && typeof filters === 'object') {
    const fid = (filters as Record<string, unknown>).projectId;
    if (typeof fid === 'string') return fid;
  }
  return null;
}

export function createMcpServer(ctx: McpContext): Server {
  const { principal } = ctx;
  const tools: McpTool[] = [
    forgeMemorySearchTool(ctx),
    forgeMemoryWriteTool(ctx),
    forgeMemoryGetTool(ctx),
    forgeMemoryDeleteTool(ctx),
    forgeMemoryFeedbackTool(ctx),
    forgeStepHandoffWriteTool(ctx),
    forgeStepHandoffGetTool(ctx),
    forgeStepHandoffDeleteTool(ctx),
    forgeSkillsListTool(ctx),
    forgeSkillsGetTool(ctx),
    forgeSkillsRegisterTool(ctx),
    forgeSkillsListRegistrationsTool(ctx),
    forgeSkillsCreateTool(ctx),
    forgeSkillsUpdateTool(ctx),
    forgeSkillsDeleteTool(ctx),
    forgeSkillsEffectiveTool(ctx),
    forgeSkillsAdoptTool(ctx),
    forgeSkillsSyncStatusTool(ctx),
    forgeSkillsPushTool(ctx),
    forgeSkillFactsListTool(ctx),
    forgeSkillFactsGetTool(ctx),
    forgeMetricsProjectRetryRescuesTool(ctx),
    forgeMetricsProjectStepDurationsTool(ctx),
    forgeMetricsProjectTimeseriesTool(ctx),
    forgeRunnersTool(ctx),
    forgeSchedulesTool(ctx),
    forgeCollaboratorsTool(ctx),
    forgeIssuesTool(ctx),
    forgePhaseTool(ctx),
    forgeStepStartTool(ctx),
    forgeCommentsTool(ctx),
    forgeFeedbackTool(ctx),
    forgeUploadsTool(ctx),
    forgeConfigTool(ctx),
    forgeKnowledgeTool(ctx),
    forgeCoolifyDeployTool(ctx),
    forgeReleaseBatchTool(ctx),
    forgeGoogleSheetsTool(ctx),
    forgeStorefrontTargetTool(ctx),
    forgeJobsListTool(ctx),
    forgeJobsGetTool(ctx),
    forgeJobsEventsTool(ctx),
    forgeJobsCancelTool(ctx),
    forgeAgentSessionsListTool(ctx),
    forgeAgentSessionsGetTool(ctx),
    forgeProjectPipelineRunsTool(ctx),
    forgePipelineRunsGetTool(ctx),
    forgeProjectsListTool(ctx),
    forgeProjectsCreateTool(ctx),
    forgeOrgsListTool(ctx),
    forgeOrgsMembersTool(ctx),
    forgeProjectsUpdateTool(ctx),
    forgeProjectsGetTool(ctx),
    forgeProjectPmTool(ctx),
    forgePmSetDependencyTool(ctx),
    forgeHealthTool(ctx),
    forgeReconcileTool(ctx),
    forgeJobsResumeTool(ctx),
    forgeMetricsSessionFailuresTool(ctx),
    // ISS-1074 wave — `forge_github` is the agent face of the GitHub integration (ISS-1062 layer 5).
    forgeGithubTool(ctx),
    // ISS-1247 — `forge_sentry` is the read side of the Sentry integration, on demand.
    forgeSentryTool(ctx),
    forgeGuideTool(ctx),
  ];
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: '@forge/core', version: pkg.version },
    { capabilities: { tools: {}, prompts: {} }, instructions: forgeMcpInstructions() },
  );

  const metaProjectId = async (): Promise<string | null> => {
    if (ctx.projectSlug) {
      try {
        return await resolveProjectIdFromSlug(ctx.projectSlug);
      } catch {
        return null;
      }
    }
    return ctx.boundProjectId ?? null;
  };

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts = await resolveManagedMetaPrompts(await metaProjectId());
    return { prompts: prompts.map((p) => ({ name: p.name, description: p.description })) };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompts = await resolveManagedMetaPrompts(await metaProjectId());
    const p = prompts.find((x) => x.name === request.params.name);
    if (!p) throw new Error(`unknown prompt: ${request.params.name}`);
    return {
      description: p.description,
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.body } }],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const tool = toolMap.get(name);
    const auditBase = {
      userId: principal.userId,
      tokenId: principal.tokenId,
      deviceId: null,
      tool: name,
      action: typeof args.action === 'string' ? args.action : null,
      projectId: projectIdFromArgs(args),
      requestId: ctx.requestId ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      payloadDigest: digestArgs(args),
    };

    if (!tool) {
      writeMcpAudit({ ...auditBase, resultCode: 'not_found' });
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const allow = patEffectiveProjectIds(principal);
    const target = auditBase.projectId;
    if (allow !== null && target && !allow.includes(target)) {
      writeMcpAudit({ ...auditBase, resultCode: 'not_found' });
      return {
        content: [{ type: 'text', text: 'NOT_FOUND: project not found or not accessible' }],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(args);
      writeMcpAudit({ ...auditBase, resultCode: 'ok' });
      return toToolCallContent(result);
    } catch (err) {
      const { code, message } = classifyError(err);
      writeMcpAudit({ ...auditBase, resultCode: code });
      const text = message.replace(/^(?:FORBIDDEN|NOT_FOUND|BAD_REQUEST):\s*/, '');
      return {
        content: [{ type: 'text', text: `Error: ${text}` }],
        isError: true,
      };
    }
  });

  return server;
}
