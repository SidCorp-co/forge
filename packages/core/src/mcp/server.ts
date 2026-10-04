import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { HTTPException } from 'hono/http-exception';
import pkg from '../../package.json' with { type: 'json' };
import { forgeChannelTool } from '../assistant/tools/forge-channel-tool.js';
import { type AuditResultCode, digestArgs, writeMcpAudit } from '../credentials/mcp-audit.js';
import { runWithPatScope } from '../credentials/pat-scope.js';
import { RefusalError } from '../lib/refusal.js';
import { resolveManagedMetaPrompts } from '../skills/effective.js';
import { forgeMcpInstructions } from './instructions.js';
import { toolCallRefusal } from './tool-call-guard.js';
import { assertToolDeclaresAccess } from './tool-grant.js';
import { toToolCallContent } from './tool-result.js';
import { forgeAgentReportTool } from './tools/forge-agent-report.js';
import { forgeCoolifyDeployTool } from './tools/forge-coolify-deploy.js';
import { forgeEcosystemTool } from './tools/forge-ecosystem.js';
import { forgeGoogleSheetsTool } from './tools/forge-google-sheets.js';
import { forgeSentryTool } from './tools/forge-sentry.js';
import { forgeSourceTool } from './tools/forge-source.js';
import { forgeStorefrontTargetTool } from './tools/forge-storefront-target.js';
import { forgeUploadsTool } from './tools/forge-uploads.js';
import { type McpContext, type McpTool, refusedAnswer } from './tools/lib.js';
import { patEffectiveProjectIds, resolveProjectIdFromSlug } from './tools/project-scope.js';

function classifyError(err: unknown): { code: AuditResultCode; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof HTTPException && err.status === 404) return { code: 'not_found', message };
  if (err instanceof HTTPException && err.status === 403) return { code: 'forbidden', message };
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

export function mcpTools(ctx: McpContext): McpTool[] {
  // The REST API is the primary door and the forge CLI sits on it; a tool is served here only
  // where an agent Forge runs needs it and neither covers it for that agent.
  const tools: McpTool[] = [
    // submit reads the caller's live job or session context, which no REST route resolves.
    forgeAgentReportTool(ctx),
    // An image attachment comes back as a viewable block; `forge-runner api` prints text only.
    forgeUploadsTool(ctx),
    // The channel's unanswered read is device-only over REST and its gate answers across the
    // ecosystem fence; the ecosystem's contract context has no REST route.
    forgeChannelTool(ctx),
    forgeEcosystemTool(ctx),
    // A core-mediated integration's agent path: the provider credential stays in core, and no REST
    // route serves these reads and writes (for Coolify, its deployment and runtime logs).
    forgeSourceTool(ctx),
    forgeCoolifyDeployTool(ctx),
    forgeSentryTool(ctx),
    forgeGoogleSheetsTool(ctx),
    forgeStorefrontTargetTool(ctx),
  ];
  for (const tool of tools) assertToolDeclaresAccess(tool);
  return tools;
}

export function toolListing(tools: McpTool[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function createMcpServer(ctx: McpContext): Server {
  const { principal } = ctx;
  const tools = mcpTools(ctx);
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolListing(tools) }));

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

    const patScope = {
      projectIds: allow,
      tokenId: principal.tokenId,
      grant: principal.permissions ?? null,
      scopes: principal.scopes,
    };
    return runWithPatScope(patScope, async () => {
      const refusal = toolCallRefusal(tool, args, {
        grant: principal.permissions,
        fence: allow,
        grantEpoch: principal.grantEpoch,
        tokenId: principal.tokenId,
      });
      if (refusal) {
        writeMcpAudit({ ...auditBase, resultCode: 'forbidden' });
        return { content: [{ type: 'text', text: `Error: ${refusal}` }], isError: true };
      }

      try {
        const result = await tool.handler(args);
        writeMcpAudit({ ...auditBase, resultCode: 'ok' });
        return toToolCallContent(result);
      } catch (err) {
        if (err instanceof RefusalError) {
          writeMcpAudit({ ...auditBase, resultCode: 'forbidden' });
          return toToolCallContent(refusedAnswer(err.refusals, err.fallbackCode));
        }
        const { code, message } = classifyError(err);
        writeMcpAudit({ ...auditBase, resultCode: code });
        const text = message.replace(/^(?:FORBIDDEN|NOT_FOUND|BAD_REQUEST):\s*/, '');
        return {
          content: [{ type: 'text', text: `Error: ${text}` }],
          isError: true,
        };
      }
    });
  });

  return server;
}
