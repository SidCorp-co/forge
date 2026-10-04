import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { HTTPException } from 'hono/http-exception';
import pkg from '../../package.json' with { type: 'json' };
import { type AuditResultCode, digestArgs, writeMcpAudit } from '../credentials/mcp-audit.js';
import { runWithPatScope } from '../credentials/pat-scope.js';
import { RefusalError } from '../lib/refusal.js';
import {
  type McpContext,
  type McpTool,
  patEffectiveProjectIds,
  refusedAnswer,
} from '../lib/tool.js';
import { toolCallRefusal } from '../lib/tool-call-guard.js';
import { assertToolDeclaresAccess } from '../lib/tool-grant.js';
import { toToolCallContent } from '../lib/tool-result.js';
import { resolveProjectIdFromSlug } from '../projects/index.js';
import { resolveManagedMetaPrompts } from '../skills/index.js';
import { forgeMcpInstructions } from './instructions.js';
import { MCP_TOOLS } from './registry.js';

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
  return Object.entries(MCP_TOOLS).map(([name, factory]) => {
    const tool = factory(ctx);
    if (tool.name !== name) {
      throw new Error(`mcp registry: the entry ${name} built a tool named ${tool.name}`);
    }
    assertToolDeclaresAccess(tool);
    return tool;
  });
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
          const answer = refusedAnswer(err.refusals, err.fallbackCode);
          const resultCode =
            answer.status === 403 ? 'forbidden' : answer.status === 404 ? 'not_found' : 'error';
          writeMcpAudit({ ...auditBase, resultCode });
          return toToolCallContent(answer);
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
