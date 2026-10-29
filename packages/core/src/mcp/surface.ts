/**
 * What `tools/list` hands every client (ISS-773): five small tools instead of every door with its
 * whole guide. A client finds the action it needs (`forge_find`), reads that action's input and
 * guide alone (`forge_describe`), and runs it (`forge_call`), so it loads only what it uses; `search`
 * and `fetch` are the two names ChatGPT's connector and deep research look for.
 *
 * `forge_call` runs an action through its door's tool on the same path a call to the tool always
 * took (`server.ts:createMcpServer`): the door's full input judges the arguments, the project fence,
 * the grant and the audit stand as they did. A door's tool called by its own name runs on that same
 * path; it is listed to no client, so an MCP client's model reaches it only through `forge_call`.
 */

import type { McpListedTool } from '@forge/contracts/mcp-tools';
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { RefusalError } from '../lib/refusal.js';
import { type McpContext, refusedAnswer } from '../lib/tool.js';
import { type ActionEntry, doorOf, findActions } from './action-catalog.js';
import { argumentRefusals, shapeOf } from './input-gate.js';
import { listedSchema } from './listed-schema.js';
import { fetchRecord, searchRecords } from './records-search.js';

const FIND_LIMIT = 20;

const INPUTS = {
  forge_find: z.strictObject({
    query: z
      .string()
      .max(200)
      .optional()
      .describe('What you want to do, in words; none lists every action'),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  forge_describe: z.strictObject({
    action: z.string().min(1).max(80).describe('An action id forge_find returned'),
  }),
  forge_call: z.strictObject({
    action: z.string().min(1).max(80).describe('An action id, e.g. requirements.create'),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The action's arguments, as forge_describe gives them"),
  }),
  search: z.strictObject({ query: z.string().min(1).max(200) }),
  fetch: z.strictObject({ id: z.string().min(1).max(120).describe('An id search returned') }),
} as const satisfies Record<McpListedTool, z.ZodType>;

export type SurfaceTool = McpListedTool;

const DESCRIPTIONS: Record<SurfaceTool, string> = {
  forge_find:
    'Find Forge actions by what you want to do (draft a requirement, file feedback, answer a question, read an issue). Returns action ids, one line each. Read one with forge_describe, run it with forge_call.',
  forge_describe: "One action's input schema and its own guide. Read it before forge_call.",
  forge_call:
    "Run one action: { action: 'requirements.create', args: {...} }. The action's full input judges args; a wrong call is refused by name, saying what to fix.",
  search:
    'Search the issues, requirements and knowledge of the projects you can read. Returns { results: [{ id, title, url }] }.',
  fetch: 'Read one item search returned, by its id: { id, title, text, url, metadata }.',
};

/** The five tools `tools/list` answers, in the plain JSON Schema every importer reads. */
export function surfaceListing(): Tool[] {
  return (Object.keys(INPUTS) as SurfaceTool[]).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: listedSchema(
      name,
      z.toJSONSchema(INPUTS[name], { io: 'input' }) as Record<string, unknown>,
    ) as Tool['inputSchema'],
  }));
}

export const isSurfaceTool = (name: string): name is SurfaceTool => Object.hasOwn(INPUTS, name);

export interface SurfaceDeps {
  ctx: McpContext;
  catalog: ReadonlyMap<string, ActionEntry>;
  /** A call to a door's tool, on the path every tool call takes (`server.ts`). */
  callDoor: (tool: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  refusal: (answer: unknown) => CallToolResult;
  answer: (value: unknown) => CallToolResult;
}

const refuse = (deps: SurfaceDeps, code: string, path: string, detail: string) =>
  deps.refusal(refusedAnswer([{ code, path, detail }], code));

/** An action's entry, or the refusal naming the action that is not one. */
function entryOr(deps: SurfaceDeps, action: string): ActionEntry | CallToolResult {
  const entry = deps.catalog.get(action);
  if (entry) return entry;
  const near = findActions(deps.catalog, action.replace(/[._]/g, ' '), 3).map((e) => e.id);
  return refuse(
    deps,
    'MCP_ACTION_UNKNOWN',
    '/action',
    `${action.slice(0, 80)} is no action${near.length ? `; nearest: ${near.join(', ')}` : ''}. forge_find { query } lists actions by what they do.`,
  );
}

const isEntry = (v: ActionEntry | CallToolResult): v is ActionEntry => 'id' in v;

/** A call to one of the five tools. */
export async function callSurface(
  name: SurfaceTool,
  raw: Record<string, unknown>,
  deps: SurfaceDeps,
): Promise<CallToolResult> {
  const schema = INPUTS[name];
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const shape = shapeOf(z.toJSONSchema(schema, { io: 'input' }) as Parameters<typeof shapeOf>[0]);
    return deps.refusal(
      refusedAnswer(argumentRefusals(name, parsed.error.issues, shape), 'BAD_REQUEST'),
    );
  }
  const input = parsed.data as Record<string, unknown>;

  if (name === 'forge_find') {
    const query = (input.query as string | undefined) ?? '';
    const limit = (input.limit as number | undefined) ?? (query ? FIND_LIMIT : 200);
    const found = findActions(deps.catalog, query, limit);
    return deps.answer({
      actions: found.map((e) => `${e.id} — ${e.summary}`),
      ...(found.length === 0
        ? {
            none: `No action matches; doors: ${[...new Set([...deps.catalog.values()].map((e) => doorOf(e.tool)))].join(', ')}`,
          }
        : {}),
      next: 'forge_describe { action } reads one; forge_call { action, args } runs it.',
    });
  }

  if (name === 'forge_describe') {
    const entry = entryOr(deps, input.action as string);
    if (!isEntry(entry)) return entry;
    return deps.answer({
      action: entry.id,
      summary: entry.summary,
      input: entry.input,
      guide: entry.guide,
      ...(entry.guideOf === 'door'
        ? { guideOf: 'door: this door names no action its own guide' }
        : {}),
      call: `forge_call { action: "${entry.id}", args }`,
    });
  }

  if (name === 'forge_call') {
    const entry = entryOr(deps, input.action as string);
    if (!isEntry(entry)) return entry;
    const args = (input.args as Record<string, unknown> | undefined) ?? {};
    if ('action' in args) {
      return refuse(
        deps,
        'MCP_CALL_ACTION_IN_ARGS',
        '/args/action',
        `args carries no action: the action is forge_call's own \`action\` (${entry.id})`,
      );
    }
    const result = await deps.callDoor(entry.tool, { ...args, action: entry.action });
    if (!result.isError) return result;
    return {
      ...result,
      content: [
        ...result.content,
        {
          type: 'text',
          text: `forge_describe { action: "${entry.id}" } answers its input and guide.`,
        },
      ],
    };
  }

  try {
    if (name === 'search') {
      return deps.answer(await searchRecords(deps.ctx.principal, input.query as string));
    }
    return deps.answer(await fetchRecord(deps.ctx.principal, input.id as string));
  } catch (err) {
    if (err instanceof RefusalError) {
      return deps.refusal(refusedAnswer(err.refusals, err.fallbackCode));
    }
    throw err;
  }
}
