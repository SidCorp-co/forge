// forge_module: the module map from an MCP client (ISS-1256), a product-layer door over the labels
// module's module map. Each action calls what its REST twin under /api/projects/:id/modules calls, judged by the contracts schema the route judges it by; the
// cards (`labels/cards.ts:MODULE_CARDS`) teach when to reach for it, and nothing here makes an agent do so.

import {
  MODULE_TOOL_READS,
  modulePlacementSchema,
  moduleRelationWriteSchema,
} from '@forge/contracts/module-map';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import {
  MODULE_CARDS,
  placeRecord,
  readModulePillar,
  readModuleTree,
  relate,
  unrelate,
} from '../labels/index.js';
import {
  type ContextScopedMcpToolFactory,
  refusedAnswer,
  sourceOf,
  zodToMcpSchema,
} from '../lib/tool.js';
import { onArg } from '../permissions/index.js';

const ACTIONS = ['get', 'pillar', 'place', 'relate', 'unrelate'] as const;
const READS = new Set<string>(MODULE_TOOL_READS);

const end = z.strictObject({ type: z.string(), ref: z.string() });

const inputSchema = z.strictObject({
  action: z.enum(ACTIONS),
  projectId: z.uuid(),
  module: z
    .string()
    .nullable()
    .optional()
    .describe('get: the module by slug or path; place: the module to place in, null to take out'),
  type: z
    .string()
    .optional()
    .describe('place: term, rule, knowledge, requirement, decision, reference, issue or lesson'),
  ref: z
    .string()
    .optional()
    .describe('place: the record (slug, REQ-n, decision id, source id, ISS-n, L-n)'),
  kind: z.string().optional().describe('relate: belongs_to, used_in, governs, from or anchored_at'),
  from: end.optional().describe('relate: { type: term | rule, ref: slug }'),
  to: end
    .optional()
    .describe(
      'relate: { type, ref }: a rule, capability, REQ-n[ BC-m], decision id, module slug or file.ts:symbol',
    ),
  relationId: z.string().optional().describe('unrelate: the relation id the tree shows'),
});

const DESCRIPTION = [
  'The module map: every business module is a pillar holding its terms, rules, capabilities, requirements, decisions and reference sources. Agents write it; core infers nothing.',
  "get {projectId, module}: one module's tree, each node with its relations, re-check and reads, and the issues in flight.",
  'pillar {projectId}: one row per business module with a count per type and its open issues, and the Unplaced row.',
  'place {projectId, type, ref, module}: set the module a record belongs to (null takes it out).',
  'relate {projectId, kind, from, to}: write one relation of the five kinds; any other kind is refused MODULE_MAP_RELATION_KIND_UNKNOWN.',
  'unrelate {projectId, relationId}: remove one relation.',
  'A term itself is written as a knowledge entry of kind glossary (`module`, `term: { aliases: { vi, code, industry }, namedBy: { who, quote } }`, `anchor`).',
].join(' ');

const missing = (action: string, field: string) =>
  refusedAnswer(
    [{ code: 'BAD_REQUEST', path: `/${field}`, detail: `${action} names \`${field}\`` }],
    'MODULE_MAP_REFUSED',
  );

export const forgeModuleTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_module',
  reach: 'project',
  route: '/api/projects',
  grant: {
    byAction: Object.fromEntries(
      ACTIONS.map((a) => [a, READS.has(a) ? 'projects:read' : 'projects:write']),
    ),
  },
  permission: {
    byAction: Object.fromEntries(
      ACTIONS.map((a) => [a, onArg(READS.has(a) ? 'project.read' : 'project.write')]),
    ),
  },
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  cards: MODULE_CARDS,
  source: sourceOf(import.meta.url),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { projectId } = input;
    switch (input.action) {
      case 'pillar':
        return readModulePillar(projectId);
      case 'get':
        return input.module ? readModuleTree(projectId, input.module) : missing('get', 'module');
      case 'place': {
        const parsed = modulePlacementSchema.safeParse({
          type: input.type,
          ref: input.ref,
          module: input.module,
        });
        return parsed.success
          ? placeRecord(projectId, parsed.data)
          : missing('place', String(parsed.error.issues[0]?.path[0] ?? 'type'));
      }
      case 'relate': {
        const parsed = moduleRelationWriteSchema.safeParse({
          kind: input.kind,
          from: input.from,
          to: input.to,
        });
        if (!parsed.success)
          return missing('relate', String(parsed.error.issues[0]?.path[0] ?? 'kind'));
        return relate(projectId, parsed.data, {
          userId: ctx.principal.userId,
          agency: principalAgency(ctx.principal),
        });
      }
      case 'unrelate':
        return input.relationId
          ? unrelate(projectId, input.relationId)
          : missing('unrelate', 'relationId');
    }
  },
});
