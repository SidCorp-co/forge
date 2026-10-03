/**
 * `forge_suggestions` — workflow `suggestion-lifecycle`: an agent proposes a change against a base
 * revision and a person decides it. accept and reject refuse an agent (SUGGESTION_ACCEPT_FORBIDDEN);
 * the REST routes in `suggestions/routes.ts` are the same services.
 */

import {
  SUGGESTION_KINDS,
  SUGGESTION_STATUSES,
  suggestionSummaryOf,
} from '@forge/contracts/suggestions';
import { z } from 'zod';
import type { NamedRefusal } from '../../project-config/respond.js';
import {
  listSuggestions,
  type SuggestionActor,
  type SuggestionTargetRef,
} from '../../suggestions/read.js';
import {
  acceptSuggestion,
  createSuggestion,
  rejectSuggestion,
  type SuggestionOutcome,
  withdrawSuggestion,
} from '../../suggestions/service.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalAgency,
  refusedAnswer,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';
import { projectMany, projectOne, summaryNotice, VIEW_RULE, viewInput } from './projection.js';

const ACTIONS = ['list', 'create', 'accept', 'reject', 'withdraw'] as const;

const inputSchema = z
  .object({
    action: z.enum(ACTIONS),
    projectId: z.uuid().optional(),
    /** The target: a requirement (uuid or REQ-n) or an issue (uuid or ISS-n). */
    requirement: z.string().trim().min(1).max(64).optional(),
    issue: z.string().trim().min(1).max(200).optional(),
    /** Or a feedback item (uuid or FB-n), for a feedback_triage suggestion. */
    feedback: z.string().trim().min(1).max(64).optional(),
    suggestionId: z.uuid().optional(),
    kind: z.enum(SUGGESTION_KINDS).optional(),
    baseRevision: z.number().int().min(1).nullable().optional(),
    payload: z.unknown().optional(),
    model: z.string().max(200).optional(),
    reason: z.string().max(4_000).optional(),
    status: z.array(z.enum(SUGGESTION_STATUSES)).optional(),
    view: viewInput,
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const write = 'projects:write';
const GRANTS = {
  byAction: {
    list: 'projects:read',
    create: write,
    accept: write,
    reject: write,
    withdraw: write,
  },
} as const;

const DESCRIPTION =
  'Suggestions (workflow suggestion-lifecycle): a proposed change that waits on a person instead of ' +
  `changing anything. Actions: ${ACTIONS.join(' | ')}. ` +
  `create: { kind: ${SUGGESTION_KINDS.join(' | ')}, requirement | issue, baseRevision, payload } — ` +
  'baseRevision is the requirement head you read (null for an issue, or a requirement with no current ' +
  'revision); a moved head is SUGGESTION_BASE_STALE, an open twin SUGGESTION_DUPLICATE, a 6th open on one ' +
  'target SUGGESTION_QUEUE_FULL, a payload that does not parse for its kind SUGGESTION_PAYLOAD_INVALID. ' +
  'revision_diff takes { reason, spec?, tldr?, changeSummary?, criteria: [{ code?, body, form? }] } on a ' +
  'requirement; requirement_draft takes { title, reason, … } on an issue; readiness { checks: [{ check, passed, detail? }] }; ' +
  'breakdown { issues: [{ title, description?, criteria?: [{ body, tracesTo? }] }], uncovered? }; ' +
  'triage { note, priority?, category?, route? } on an issue; duplicate { duplicateOf, similarity?, note? }; ' +
  'feedback_triage on `feedback` (FB-n), baseRevision null: { route: issue | revision | new_requirement | answer | duplicate, issue? | createIssue? | suggestion? | requirement? | title? | answer? | duplicateOf?, kind?, severity?, note? }; accepting it writes the route (forge_feedback_items). ' +
  'accept / reject { suggestionId, reason } are a person’s acts (SUGGESTION_ACCEPT_FORBIDDEN for an agent); ' +
  'accepting a revision_diff writes a new DRAFT revision, never a current one. withdraw: the producer retracts its own. ' +
  'list: { requirement | issue, status? } answers each suggestion as { id, kind, status, target, baseRevision, ' +
  'producerKind, producerId, model, decidedBy, decidedAt, createdAt, payloadPurgedAt }, without its payload, ' +
  'fingerprint or decision reason; a write answers the same summary of the suggestion it wrote, and the effect. ' +
  VIEW_RULE;

function need<K extends keyof Input>(input: Input, key: K): NonNullable<Input[K]> {
  const value = input[key];
  if (value === undefined || value === null) {
    throw new Error(`BAD_REQUEST: ${input.action} needs \`${String(key)}\``);
  }
  return value as NonNullable<Input[K]>;
}

const refusedBy = (refusals: readonly NamedRefusal[]) =>
  refusedAnswer(refusals, 'SUGGESTION_REFUSED');

const settle = (input: Input, outcome: SuggestionOutcome) =>
  outcome.ok
    ? {
        suggestion: projectOne(input.view, outcome.suggestion, suggestionSummaryOf),
        ...(outcome.effect ? { effect: outcome.effect } : {}),
      }
    : refusedBy(outcome.refusals);

function targetOf(input: Input): SuggestionTargetRef | undefined {
  if ([input.requirement, input.issue, input.feedback].filter(Boolean).length > 1) {
    throw new Error('BAD_REQUEST: name one target, `requirement`, `issue` or `feedback`');
  }
  if (input.requirement) return { requirement: input.requirement };
  if (input.issue) return { issue: input.issue };
  if (input.feedback) return { feedback: input.feedback };
  return undefined;
}

async function run(args: unknown, ctx: McpContext): Promise<unknown> {
  const input = inputSchema.parse(args);
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  const actor: SuggestionActor = {
    userId: ctx.principal.userId,
    agency: principalAgency(ctx.principal),
  };
  switch (input.action) {
    case 'list': {
      const listed = await listSuggestions({
        projectId,
        userId: actor.userId,
        target: targetOf(input),
        statuses: input.status,
      });
      return {
        suggestions: projectMany(input.view, listed.suggestions, suggestionSummaryOf),
        open: listed.open,
        ...summaryNotice(input.view, "view: 'full' for each suggestion's payload and reason"),
      };
    }
    case 'create': {
      const target = targetOf(input);
      if (!target)
        throw new Error('BAD_REQUEST: create needs `requirement`, `issue` or `feedback`');
      return settle(
        input,
        await createSuggestion({
          projectId,
          actor,
          producerKind: actor.agency === 'agent' ? 'agent' : 'person',
          producerId: actor.userId,
          kind: need(input, 'kind'),
          target,
          baseRevision: input.baseRevision ?? null,
          payload: input.payload,
          model: input.model ?? null,
        }),
      );
    }
    case 'accept':
      return settle(
        input,
        await acceptSuggestion({ projectId, id: need(input, 'suggestionId'), actor }),
      );
    case 'reject':
      return settle(
        input,
        await rejectSuggestion({
          projectId,
          id: need(input, 'suggestionId'),
          actor,
          reason: input.reason,
        }),
      );
    case 'withdraw':
      return settle(
        input,
        await withdrawSuggestion({ projectId, id: need(input, 'suggestionId'), actor }),
      );
  }
}

export const forgeSuggestionsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_suggestions',
  reach: 'project',
  grant: GRANTS,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => run(args, ctx),
});
