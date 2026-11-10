import { redactQueryParams, scrubLogText, scrubSecretsDeep } from '@forge/observability';
import { type CallToolResult, Server, type Tool } from '@modelcontextprotocol/server';
import { HTTPException } from 'hono/http-exception';
import pkg from '../../package.json' with { type: 'json' };
import { type AuditResultCode, digestArgs, writeMcpAudit } from '../credentials/mcp-audit.js';
import { runWithPatScope } from '../credentials/pat-scope.js';
import { RETIRED_MCP_TOOLS } from '../forge-door/index.js';
import { RefusalError, thrownEnvelope } from '../lib/refusal.js';
import {
  type McpContext,
  type McpTool,
  patEffectiveProjectIds,
  refusedAnswer,
} from '../lib/tool.js';
import { toolCallRefusal } from '../lib/tool-call-guard.js';
import { assertToolDeclaresAccess, toolGrantFor } from '../lib/tool-grant.js';
import { toToolCallContent } from '../lib/tool-result.js';
import { chatToolWriteRefusal } from '../middleware/chat-write-hold.js';
import { runDeclaredTool } from '../permissions/index.js';
import { resolveProjectIdFromSlug } from '../projects/index.js';
import { resolveManagedMetaPrompts } from '../skills/index.js';
import { actionCatalog } from './action-catalog.js';
import { actionRefusal, gatedTool } from './input-gate.js';
import { listedSchema } from './listed-schema.js';
import { MCP_TOOLS } from './registry.js';
import { callSurface, isSurfaceTool, type SurfaceDeps, surfaceListing } from './surface.js';

function classifyError(err: unknown): { code: AuditResultCode; message: string } {
  const message = redactQueryParams(err instanceof Error ? err.message : String(err), err);
  if (err instanceof HTTPException && err.status === 404) return { code: 'not_found', message };
  if (err instanceof HTTPException && err.status === 403) return { code: 'forbidden', message };
  if (message.startsWith('NOT_FOUND')) return { code: 'not_found', message };
  if (message.startsWith('FORBIDDEN')) return { code: 'forbidden', message };
  return { code: 'error', message };
}

// a refused or failed call's answer echoes what the caller sent at most by name; whatever a refusal
// quotes passes the secret scrubber, so a credential sent in the wrong place does not come back
const errorAnswer = (text: string): CallToolResult => ({
  content: [{ type: 'text', text: scrubLogText(text) }],
  isError: true,
});

const refusalAnswer = (answer: unknown) => toToolCallContent(scrubSecretsDeep(answer));

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

type InputSchema = { properties?: Record<string, InputSchema>; additionalProperties?: unknown };

/**
 * Whether a tool takes the project it works in by argument, where `projectIdFromArgs` reads it: a
 * `projectId` its input names at the top or under `filters`. Only such a tool is fenced by that
 * argument before its handler runs. A tool that takes none (`forge_feedback` files into Forge's
 * home, `forge_uploads` reads an attachment's own project) meets a `projectId` as a wrong argument,
 * refused by name by its own input, so its input must refuse keys it does not name.
 */
export function takesProjectArgument(tool: Pick<McpTool, 'name' | 'inputSchema'>): boolean {
  const input = tool.inputSchema as InputSchema;
  if (input.properties?.projectId || input.properties?.filters?.properties?.projectId) return true;
  if (input.additionalProperties !== false) {
    throw new Error(
      `mcp registry: ${tool.name} takes no projectId and its input lets keys it does not name through, so a projectId sent to it would be dropped in silence; make its input strict, or let it take the project it works in`,
    );
  }
  return false;
}

/**
 * A tool's input as MCP lists it: a JSON Schema whose `type` is `object`, in the plain subset every
 * client's importer reads (`listedSchema`). Every tool publishes its input through `zodToMcpSchema`,
 * which yields one for an object schema; any other shape is refused by the tool's name when the
 * registry is built, not handed to a client as a listing it rejects. A call is still judged by the
 * schema the tool published, which the listing accepts exactly as (`listed-schema.test.ts`).
 */
function listedInput(tool: Pick<McpTool, 'name' | 'inputSchema'>): Tool['inputSchema'] {
  const input = tool.inputSchema;
  if (input.type !== 'object') {
    throw new Error(
      `mcp registry: ${tool.name}'s input publishes type ${JSON.stringify(input.type)}, and MCP lists a tool's input as a JSON Schema object (type "object"); make its input a zod object`,
    );
  }
  return listedSchema(tool.name, input) as Tool['inputSchema'];
}

export function mcpTools(ctx: McpContext): McpTool[] {
  return Object.entries(MCP_TOOLS).map(([name, factory]) => {
    const tool = factory(ctx);
    if (tool.name !== name) {
      throw new Error(`mcp registry: the entry ${name} built a tool named ${tool.name}`);
    }
    assertToolDeclaresAccess(tool);
    takesProjectArgument(tool);
    listedInput(tool);
    return gatedTool(tool);
  });
}

export function toolListing(tools: McpTool[]): (Tool & { description: string })[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: listedInput(t),
  }));
}

export function createMcpServer(ctx: McpContext): Server {
  const { principal } = ctx;
  const tools = mcpTools(ctx);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const projectTaking = new Set(tools.filter(takesProjectArgument).map((t) => t.name));

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

  server.setRequestHandler('prompts/list', async () => {
    const prompts = await resolveManagedMetaPrompts(await metaProjectId());
    return { prompts: prompts.map((p) => ({ name: p.name, description: p.description })) };
  });

  server.setRequestHandler('prompts/get', async (request) => {
    const prompts = await resolveManagedMetaPrompts(await metaProjectId());
    const p = prompts.find((x) => x.name === request.params.name);
    if (!p) throw new Error(`unknown prompt: ${request.params.name}`);
    return {
      description: p.description,
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.body } }],
    };
  });

  // every client is listed the five tools that find, describe and run an action (ISS-773)
  server.setRequestHandler('tools/list', async () => ({ tools: surfaceListing() }));

  /** A call to a door's tool: the path every tool call takes, judged against the door's full input. */
  const callDoor = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const tool = toolMap.get(name);
    // a projectId sent to a tool that takes none names no project the call works in
    const target = tool && !projectTaking.has(name) ? null : projectIdFromArgs(args);
    const auditBase = {
      userId: principal.userId,
      tokenId: principal.tokenId,
      deviceId: null,
      tool: name,
      action: typeof args.action === 'string' ? args.action : null,
      projectId: target,
      requestId: ctx.requestId ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      payloadDigest: digestArgs(args),
    };

    if (!tool) {
      writeMcpAudit({ ...auditBase, resultCode: 'not_found' });
      const retired = RETIRED_MCP_TOOLS[name];
      if (retired) return refusalAnswer(refusedAnswer([retired], retired.code));
      return errorAnswer(`Unknown tool: ${name}`);
    }

    const allow = patEffectiveProjectIds(principal);
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
      grant: principal.permissions,
      scopes: principal.scopes,
    };
    return runWithPatScope(patScope, async () => {
      const undeclared = actionRefusal(tool, args);
      if (undeclared) {
        writeMcpAudit({ ...auditBase, resultCode: 'error' });
        return refusalAnswer({ _mcpIsError: true, ...thrownEnvelope(undeclared) });
      }
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
      // a chat credential's write meets the chat write rule here as it does on REST (REQ-30 BC-4)
      const chatRefusal = await chatToolWriteRefusal(name, args, toolGrantFor(tool, args) ?? null);
      if (chatRefusal) {
        writeMcpAudit({ ...auditBase, resultCode: 'forbidden' });
        return errorAnswer(`Error: ${chatRefusal}`);
      }

      try {
        // what the action declares is checked here, before its handler (REQ-12 BC-20)
        const result = await runDeclaredTool(tool, args, principal.userId);
        const refused = (result as { _mcpIsError?: unknown } | null)?._mcpIsError === true;
        writeMcpAudit({ ...auditBase, resultCode: 'ok' });
        return refused ? refusalAnswer(result) : toToolCallContent(result);
      } catch (err) {
        if (err instanceof RefusalError) {
          const answer = thrownEnvelope(err);
          const resultCode =
            answer.status === 403 ? 'forbidden' : answer.status === 404 ? 'not_found' : 'error';
          writeMcpAudit({ ...auditBase, resultCode });
          return refusalAnswer({ _mcpIsError: true, ...answer });
        }
        const { code, message } = classifyError(err);
        writeMcpAudit({ ...auditBase, resultCode: code });
        return errorAnswer(
          `Error: ${message.replace(/^(?:FORBIDDEN|NOT_FOUND|BAD_REQUEST):\s*/, '')}`,
        );
      }
    });
  };

  const surface: SurfaceDeps = {
    ctx,
    catalog: actionCatalog(tools),
    callDoor,
    refusal: refusalAnswer,
    answer: toToolCallContent,
  };

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    if (isSurfaceTool(name)) return callSurface(name, args, surface);
    return callDoor(name, args);
  });

  return server;
}

/**
 * What a client loads on connecting (REQ-78 BC-10): a map, never the manual. Each further layer is
 * loaded when the step needs it: find, describe, call, then a guide through `fetch guide:<slug>`.
 */
export function forgeMcpInstructions(): string {
  return `You are connected to Forge, where agents and people run one loop for a project: Product → Delivery → Release → Audit → Product. This server carries the Product side, for a person or an agent working as product owner, BA or project manager. Delivery (building, landing, deploying) is the project's master and its runs, working from a checkout.

Load each layer only when your step needs it:
1. \`forge_find { query }\` lists the actions for what you want, one line each. An action is \`<door>.<action>\`.
2. \`forge_describe { action }\` gives one action's input, its guide, and in \`more\` the Forge guide to read for more.
3. \`forge_call { action, args }\` runs it. A refusal names what to fix.
4. A guide, when a describe or a refusal names one: \`fetch { id: "guide:<slug>" }\`; \`guide:index\` lists them, and \`guide:agent-setup\` names each role's.
\`search\` and \`fetch\` also read the issues, requirements and knowledge of the projects you can read.

Where a Product role starts (\`projects.list\` finds the project):
- \`project.status\`, then \`project.needs_you\` and \`project.decisions\`.
- \`requirements.*\` and \`design.*\`: what is wanted. \`project_feedback.*\`: what users report. \`releases.*\` and \`questions.*\`.
- \`bot.*\`: ask the Forge bot, the project's chat assistant, for a report or a job no action here does.
- \`issues.*\` is Delivery's: read it for progress; \`issues.create\`'s guide says when to file one.
- \`feedback.*\` is feedback about Forge itself.

Every answer about work in motion carries \`progress\`: tell the person \`progress.says\`, never a date it does not hold.

From a checkout (a master or a run), the REST routes, the CLI and the recall-first rule are in \`guide:agent-setup\`.`;
}
