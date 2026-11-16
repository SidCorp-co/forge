// forge_references: a project's reference sources from an MCP client (ISS-1252), the product layer a
// person or a bot works from. Every action calls what its REST twin under
// /api/projects/:id/reference-sources calls, and each request is judged by the contracts schema the
// route judges it by. The door's capability cards (`@forge/contracts/references:REFERENCE_CARDS`)
// teach when to reach for it; nothing here makes an agent do so.

import {
  REFERENCE_ADD_SHAPE,
  REFERENCE_CARDS,
  REFERENCE_CITE_SHAPE,
  REFERENCE_KINDS,
  REFERENCE_PROPOSE_SHAPE,
  REFERENCE_UPDATE_SHAPE,
  REFERENCE_VERDICTS,
  REFERENCES_TOOL_READS,
  referenceAddRequestSchema,
  referenceCiteRequestSchema,
  referenceProposeRequestSchema,
  referenceRemoveRequestSchema,
  referenceSearchQuerySchema,
  referenceUpdateRequestSchema,
} from '@forge/contracts/references';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import type { Refusal } from '../lib/refusal.js';
import {
  type ContextScopedMcpToolFactory,
  refusedAnswer,
  sourceOf,
  zodToMcpSchema,
} from '../lib/tool.js';
import { onArg } from '../permissions/index.js';
import { searchSources, timelineOf } from './read.js';
import { addSource, citeSource, proposeSource, removeSource, updateSource } from './service.js';
import { referenceSignals } from './signals.js';

const ACTIONS = [
  'search',
  'add',
  'propose',
  'update',
  'remove',
  'cite',
  'signals',
  'timeline',
] as const;
const READS = new Set<string>(REFERENCES_TOOL_READS);

const inputSchema = z.strictObject({
  action: z.enum(ACTIONS),
  projectId: z.uuid(),
  area: z.string().optional().describe('search: an area or module the source informs'),
  q: z.string().optional().describe('search: words its name, address, why or areas hold'),
  source: z
    .string()
    .optional()
    .describe('update, remove, cite, timeline: the source, by id, address or name (`owner/name`)'),
  kind: z.enum(REFERENCE_KINDS).optional(),
  url: z.string().optional().describe('add, propose: the http(s) address of the source'),
  title: z.string().optional(),
  why: z
    .string()
    .optional()
    .describe(
      'add, propose, update: what this project learns from it; cite: why you took or rejected it',
    ),
  areas: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  followReleases: z.boolean().optional(),
  shared: z
    .boolean()
    .optional()
    .describe("add: the org's, shared by every project of it (org admin)"),
  evidence: z.string().optional().describe('propose: the work it helped and what was taken'),
  reason: z.string().optional().describe('remove: why it goes'),
  ref: z.string().optional().describe('cite: the repo path, doc or release read'),
  verdict: z.enum(REFERENCE_VERDICTS).optional(),
  about: z.string().optional().describe('cite: the work it was read for, ISS-n, REQ-n or FB-n'),
});
type Input = z.infer<typeof inputSchema>;

const DESCRIPTION = [
  'The sources this project learns from first: repos, products, projects, patterns and docs, each with why, the areas it informs and whether its releases are followed; the project’s own first, then its org’s.',
  'search {projectId, area, q}: the active sources, narrowed to an area and to words; neither, every one.',
  `add {projectId, kind, url, why, areas, title, priority, followReleases, shared}: add one, ${REFERENCE_ADD_SHAPE}. Only a github.com repository’s releases are followed (REFERENCE_FOLLOW_UNSUPPORTED otherwise); an address already held is REFERENCE_SOURCE_DUPLICATE.`,
  `propose {projectId, kind, url, why, areas, title, priority, followReleases, evidence}: an agent’s add of a source it kept using, recorded as its proposal, ${REFERENCE_PROPOSE_SHAPE}.`,
  `update {projectId, source, kind, title, why, areas, priority, followReleases}: change one, ${REFERENCE_UPDATE_SHAPE}; an org entry is its admin’s (REFERENCE_SHARED_FORBIDDEN).`,
  'remove {projectId, source, reason}: remove one; it is kept with its citations and timeline and never served again.',
  `cite {projectId, source, ref, verdict, why, about}: record one use of a source, ${REFERENCE_CITE_SHAPE}.`,
  'signals {projectId}: per source, its citations (taken, rejected, recent), the ideas its releases filed and what became of them, and its flags (archived, unmaintained, uncited 90 days) for keep, replace or remove.',
  'timeline {projectId, source}: the releases read from a followed source, each an idea on the open item it may help or silent.',
  'A refusal answers { error: { code, message, refusals: [{ code, path, detail }] } } and writes nothing.',
].join(' ');

/** The fields `schema` takes, out of the flat input, judged by it; a refusal names each bad field. */
function judged<T extends z.ZodType>(
  schema: T,
  input: Input,
  names: readonly (keyof Input)[],
  shape: string,
): { ok: true; value: z.infer<T> } | { ok: false; answer: ReturnType<typeof refusedAnswer> } {
  const picked = Object.fromEntries(
    names.filter((n) => input[n] !== undefined).map((n) => [n, input[n]]),
  );
  const parsed = schema.safeParse(picked);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    answer: refusedAnswer(
      parsed.error.issues.map((i) => ({
        code: 'BAD_REQUEST',
        path: `/${i.path.join('/')}`,
        detail: `${i.message}; ${input.action} takes ${shape}`,
      })),
      'REFERENCE_REFUSED',
    ),
  };
}

const ENTRY = ['kind', 'url', 'title', 'why', 'areas', 'priority', 'followReleases'] as const;

const needSource = (input: Input) =>
  input.source
    ? null
    : refusedAnswer(
        [
          {
            code: 'BAD_REQUEST',
            path: '/source',
            detail: `${input.action} names the source, by id, address or name`,
          },
        ],
        'REFERENCE_REFUSED',
      );

function answered<T extends object>(out: ({ ok: true } & T) | { ok: false; refusals: Refusal[] }) {
  return out.ok ? out : refusedAnswer(out.refusals, 'REFERENCE_REFUSED');
}

export const forgeReferencesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_references',
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
  cards: REFERENCE_CARDS,
  source: sourceOf(import.meta.url),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { projectId } = input;
    const actor = { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) };
    switch (input.action) {
      case 'search': {
        const q = judged(referenceSearchQuerySchema, input, ['area', 'q'], '{ area?, q? }');
        return q.ok ? { sources: await searchSources(projectId, q.value) } : q.answer;
      }
      case 'signals':
        return referenceSignals(projectId);
      case 'add': {
        const r = judged(
          referenceAddRequestSchema,
          input,
          [...ENTRY, 'shared'],
          REFERENCE_ADD_SHAPE,
        );
        return r.ok ? answered(await addSource({ projectId, actor, request: r.value })) : r.answer;
      }
      case 'propose': {
        const r = judged(
          referenceProposeRequestSchema,
          input,
          [...ENTRY, 'evidence'],
          REFERENCE_PROPOSE_SHAPE,
        );
        return r.ok
          ? answered(await proposeSource({ projectId, actor, request: r.value }))
          : r.answer;
      }
      case 'update': {
        const missing = needSource(input);
        if (missing) return missing;
        const r = judged(referenceUpdateRequestSchema, input, ENTRY, REFERENCE_UPDATE_SHAPE);
        return r.ok
          ? answered(
              await updateSource({
                projectId,
                actor,
                ref: input.source as string,
                request: r.value,
              }),
            )
          : r.answer;
      }
      case 'remove': {
        const missing = needSource(input);
        if (missing) return missing;
        const r = judged(referenceRemoveRequestSchema, input, ['reason'], '{ reason }');
        return r.ok
          ? answered(
              await removeSource({
                projectId,
                actor,
                ref: input.source as string,
                reason: r.value.reason,
              }),
            )
          : r.answer;
      }
      case 'cite': {
        const missing = needSource(input);
        if (missing) return missing;
        const r = judged(
          referenceCiteRequestSchema,
          input,
          ['ref', 'verdict', 'why', 'about'],
          REFERENCE_CITE_SHAPE,
        );
        return r.ok
          ? citeSource({ projectId, actor, ref: input.source as string, request: r.value })
          : r.answer;
      }
      case 'timeline': {
        const missing = needSource(input);
        return missing ?? timelineOf(projectId, input.source as string);
      }
    }
  },
});
