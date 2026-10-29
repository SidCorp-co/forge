import { redactQueryParams, scrubLogText, scrubSecretsDeep } from '@forge/observability';
import { type CallToolResult, Server, type Tool } from '@modelcontextprotocol/server';
import { HTTPException } from 'hono/http-exception';
import pkg from '../../package.json' with { type: 'json' };
import { type AuditResultCode, digestArgs, writeMcpAudit } from '../credentials/mcp-audit.js';
import { runWithPatScope } from '../credentials/pat-scope.js';
import { RETIRED_MCP_TOOLS } from '../forge-door/index.js';
import { env } from '../lib/env.js';
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
import { resolveProjectIdFromSlug } from '../projects/index.js';
import { resolveManagedMetaPrompts } from '../skills/index.js';
import { actionRefusal, gatedTool } from './input-gate.js';
import { listedSchema } from './listed-schema.js';
import { MCP_TOOLS } from './registry.js';

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

  server.setRequestHandler('tools/list', async () => ({ tools: toolListing(tools) }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
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
        const result = await tool.handler(args);
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
  });

  return server;
}

/** The public, credential-free address of the guide corpus, on the web host. */
function publicGuidesUrl(): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/guides`;
}

/** Built per call so `env` is read lazily and this module stays side-effect free. */
function forgeMcpInstructions(): string {
  return `You are connected to a Forge-managed project — Forge is the control plane for this repo's issues, pipeline, and durable memory. The REST API (\`<host>/api/...\`, a personal access token as \`Authorization: Bearer\`) is the primary door and the \`forge\` CLI sits on it; this server carries the product layer a BA works in, so a person can work from an MCP client, and what neither covers:

- \`forge_requirements\` — list, read, draft and revise requirements (REQ-n), propose a draft revision, and answer a question standing on one with what the person said; agreeing and accepting stay a person's act on the requirement page.
- \`project_feedback\` — a project's own feedback (FB-n): list, read and file it, find similar items, and ask a reporter a clarification; triage stays a person's act.
- \`forge_feedback\` — feedback about Forge itself (its CLI, routes, tools, guides, web app), from any project: filed as you into Forge's own home project, never into the project you work in; list and read the items you reported and how they are going.
- \`forge_releases\` — releases: what shipped, what is drafted, what waits on approval; name one, and decide its approval where you hold releases.approve.
- \`forge_design\` — workflow designs, suggestions and mockups: read them, write and propose a design, and approve, return, accept, reject, revise or withdraw where you hold the permission.
- \`forge_questions\` — questions waiting on a person, one read in full, the person's answer in their own words, and your own question on an issue.
- \`forge_issues\` — delivery work read: each issue's status, whether an agent works on it now and when it is likely done. It files no issue: \`create\` is refused MCP_FILES_FEEDBACK_NOT_ISSUES and says where the record goes instead (Feedback, a Requirement, or a question).
- \`forge_uploads\` — read an issue, comment or session attachment; an image comes back as a viewable block.

Every answer about work in motion carries \`progress\`: whether work is running now, what waits on whom, and the forecast date, or plainly why there is none. Tell the person \`progress.says\`; never give a date it does not hold.

Everything else is REST or the CLI:
- Delivery has no tool here, and \`forge_source\`, \`forge_coolify_deploy\`, \`forge_sentry\` and \`forge_storefront_target\` are refused MCP_DELIVERY_IS_REST naming their routes. A connected integration's credential stays in core and the call is made from core: Coolify deploys and logs under \`/api/projects/:id/integrations/coolify/…\`, the source host's change requests under \`/api/projects/:id/integrations/source/…\` (open one with \`POST /api/projects/:id/integrations/source/change-requests\` \`{ head, base, title, body?, draft? }\`; from a runner pane, \`forge-runner api\` on that path), Sentry under \`/api/projects/:id/integrations/sentry/issues\`, and the storefront target at \`GET /api/projects/:id/integrations/storefront/target\`. Never open a change request with a host token of your own: core's door records it, and is the only one attributable to you.
- Friction with Forge itself, a skill gap or a learning mid-run: \`forge_feedback\` action \`submit\`, or \`POST /api/forge/feedback\` \`{ kind, title, whereSeen, body?, signalKey?, clientVersion? }\`, which reads your live job from the token and files it into Forge's home project as you.
- A project's ecosystem channel, interface, links and builder runs: \`/api/projects/:id/channel/…\`, \`/api/projects/:id/interface\`, \`/api/projects/:id/links\`, \`/api/projects/:id/builder-runs\`; what the channel owes a reply to is \`GET /api/projects/:id/channel/unanswered\`, and the contracts a set of repository paths calls, recorded on a session, is \`POST /api/projects/:id/contract-context { paths, session? }\`. How a master works the inbox: \`GET <host>/api/guides/ecosystem-inbox.md\`. \`forge_channel\` and \`forge_ecosystem\` still answer the same actions here for forge-plugin clients; prefer the routes.
- Project memory is NOT auto-loaded. At the start of any task needing project context, recall it first: \`POST /api/memory/search\` \`{ projectId, query, topK: 5 }\`. Hits are point-in-time — verify against live code/git before trusting, then report it at \`POST /api/memory/feedback\`.
- Project prose (build commands, rules, guides): \`/api/projects/:id/knowledge\` or \`forge knowledge\`. Settings: \`GET /api/projects/:id/config\` → \`document\`, the project document (environments, their URLs, promotions and the testing profile each names; a testing profile holds \`secret://\` references, never a credential).
- Issues, comments, status and dependencies: \`/api/projects/:id/issues\`, \`/api/issues/:id\`, \`/api/issues/:id/comments\`, or \`forge issue\` / \`forge new\` / \`forge comment\`. A chat session (the Forge assistant, Ask Agent) files no issue: it records Feedback or a Requirement draft or revision, and \`forge new\` is refused for it with CHAT_FILES_FEEDBACK_NOT_ISSUES unless the project's gate profile turns \`chat_files_issue\` off (yolo). A comment a person marks as a question on an issue (\`intent: question\`) is owed a reply, at any status but closed or dropped, until an agent replies in its thread; a comment sent with no intent is a note, owed nothing. An agent's question comment is a Question waiting on a person, with the comment's id: the answer is read at \`GET /api/questions/<comment id>\`.
- Before writing, rewriting, or tuning this project's pipeline skills, read the \`forge-skills\` MCP prompt (the always-latest authoring guide).
- The API contract is fetchable with no credential: \`<host>/api/openapi.json\` is OpenAPI 3.1 for every route core mounts, and \`<host>/api/mcp-tools.json\` lists these tools as tools/list answers them. Each carries a semver version that moves only when the contract does; pin it, and revalidate with the ETag.
- Forge capability guides are fetchable, not preloaded: \`<host>/api/guides\` lists them and \`<host>/api/guides/<slug>.md\` reads one. Look one up before guessing how a Forge feature works. The corpus is public and needs no credential; readable pages for a person are at ${publicGuidesUrl()}.

This project's projectId is in the repo's CLAUDE.md.`;
}
