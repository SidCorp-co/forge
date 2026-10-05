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
import { env } from '../lib/env.js';
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
import { MCP_TOOLS } from './registry.js';

function classifyError(err: unknown): { code: AuditResultCode; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof HTTPException && err.status === 404) return { code: 'not_found', message };
  if (err instanceof HTTPException && err.status === 403) return { code: 'forbidden', message };
  if (message.startsWith('NOT_FOUND')) return { code: 'not_found', message };
  if (message.startsWith('FORBIDDEN')) return { code: 'forbidden', message };
  return { code: 'error', message };
}

const errorAnswer = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

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
      return errorAnswer(`Unknown tool: ${name}`);
    }

    const allow = patEffectiveProjectIds(principal);
    const target = auditBase.projectId;
    if (allow !== null && target && !allow.includes(target)) {
      writeMcpAudit({ ...auditBase, resultCode: 'not_found' });
      return errorAnswer('NOT_FOUND: project not found or not accessible');
    }

    const patScope = {
      projectIds: allow,
      tokenId: principal.tokenId,
      userId: principal.userId,
      agency: principal.agency,
      onBehalfOf: principal.onBehalfOf,
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
        return errorAnswer(`Error: ${refusal}`);
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
        return errorAnswer(
          `Error: ${message.replace(/^(?:FORBIDDEN|NOT_FOUND|BAD_REQUEST):\s*/, '')}`,
        );
      }
    });
  });

  return server;
}

/** The public, credential-free address of the guide corpus, on the web host. */
function publicGuidesUrl(): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/guides`;
}

/** Built per call so `env` is read lazily and this module stays side-effect free. */
function forgeMcpInstructions(): string {
  return `You are connected to a Forge-managed project — Forge is the control plane for this repo's issues, pipeline, and durable memory. The REST API (\`<host>/api/...\`, a personal access token as \`Authorization: Bearer\`) is the primary door and the \`forge\` CLI sits on it; this server carries only what neither covers:

- \`forge_uploads\` — read an issue, comment or session attachment; an image comes back as a viewable block.
- \`forge_source\`, \`forge_coolify_deploy\`, \`forge_sentry\`, \`forge_storefront_target\` — a connected integration whose credential stays in core.

Everything else is REST or the CLI:
- Friction, a skill gap or a learning mid-run: \`POST /api/agent-reports\` \`{ projectId, kind, target, summary, severity?, targetRef?, detail?, suggestion? }\`, which reads your live job from the token; \`GET /api/agent-reports\` reads the feed and \`POST /api/agent-reports/:id/triage\` decides one.
- A project's ecosystem channel, interface, links and builder runs: \`/api/projects/:id/channel/…\`, \`/api/projects/:id/interface\`, \`/api/projects/:id/links\`, \`/api/projects/:id/builder-runs\`; what the channel owes a reply to is \`GET /api/projects/:id/channel/unanswered\`, and the contracts a set of repository paths calls, recorded on a session, is \`POST /api/projects/:id/contract-context { paths, session? }\`. How a master works the inbox: \`GET <host>/api/guides/ecosystem-inbox.md\`. \`forge_agent_report\`, \`forge_channel\` and \`forge_ecosystem\` still answer the same actions here for forge-plugin clients; prefer the routes.
- Project memory is NOT auto-loaded. At the start of any task needing project context, recall it first: \`POST /api/memory/search\` \`{ projectId, query, topK: 5 }\`. Hits are point-in-time — verify against live code/git before trusting, then report it at \`POST /api/memory/feedback\`.
- Project prose (build commands, rules, guides): \`/api/projects/:id/knowledge\` or \`forge knowledge\`. Settings: \`GET /api/projects/:id/config\` → \`document\`, the project document (environments, their URLs, promotions and the testing profile each names; a testing profile holds \`secret://\` references, never a credential).
- Issues, comments, status and dependencies: \`/api/projects/:id/issues\`, \`/api/issues/:id\`, \`/api/issues/:id/comments\`, or \`forge issue\` / \`forge new\` / \`forge comment\`. A person's question comment on an issue (\`intent: question\`) is owed a reply, at any status but closed or dropped, until an agent replies in its thread.
- Before writing, rewriting, or tuning this project's pipeline skills, read the \`forge-skills\` MCP prompt (the always-latest authoring guide).
- Forge capability guides are fetchable, not preloaded: \`<host>/api/guides\` lists them and \`<host>/api/guides/<slug>.md\` reads one. Look one up before guessing how a Forge feature works. The corpus is public and needs no credential; readable pages for a person are at ${publicGuidesUrl()}.

This project's projectId is in the repo's CLAUDE.md.`;
}
