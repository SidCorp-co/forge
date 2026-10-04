/**
 * `forge_suggestions` — an agent proposes a change against a base revision and a person decides it
 * (guide `suggestions`). accept and reject refuse an agent (SUGGESTION_ACCEPT_FORBIDDEN);
 * the REST routes in `suggestions/routes.ts` are the same services.
 */

import {
  SUGGESTION_KINDS,
  SUGGESTION_STATUSES,
  suggestionSummaryOf,
} from '@forge/contracts/suggestions';
import { z } from 'zod';
import { guideRef } from '../../guides/guide-ref.js';
import { dataPolicyOf, egressAt, egressOr } from '../../lib/data-egress.js';
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
  reviseSuggestion,
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

const ACTIONS = ['list', 'create', 'accept', 'reject', 'revise', 'withdraw'] as const;

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
    revise: write,
    withdraw: write,
  },
} as const;

const DESCRIPTION =
  `Suggestions (${guideRef('suggestions')}): a proposed change that waits on a person instead of ` +
  `changing anything. Actions: ${ACTIONS.join(' | ')}. ` +
  `create: { kind: ${SUGGESTION_KINDS.join(' | ')}, requirement | issue, baseRevision, payload } — ` +
  'baseRevision is the requirement head you read (null for an issue, or a requirement with no current ' +
  'revision); a moved head is SUGGESTION_BASE_STALE, an open twin SUGGESTION_DUPLICATE, a 6th open on one ' +
  'target SUGGESTION_QUEUE_FULL, a payload that does not parse for its kind SUGGESTION_PAYLOAD_INVALID. ' +
  'revision_diff takes { reason, spec?, tldr?, changeSummary?, criteria: [{ code?, body, form? }] } on a ' +
  'requirement; requirement_draft takes { title, reason, … } on an issue; readiness { checks: [{ check, passed, detail? }] }; ' +
  'breakdown { issues: [{ title, description?, complexity: xs | s | m | l | xl, priority?, category?, builds?: flow | null, criteria?: [{ body, tracesTo? }], blockedBy?: [index | issue key] }], uncovered? } — ' +
  'priority defaults to medium and category to feature, and the accept effect names each issue it defaulted; builds names the ' +
  'pinned design the issue builds (left out: the one design the latest baseline pins; several pinned is SUGGESTION_BUILD_UNNAMED, ' +
  'a flow it does not pin SUGGESTION_BUILD_UNPINNED), linked as the issue’s build so the build gate holds it; ' +
  'a blockedBy number is another issue of this breakdown, a string an existing live issue of the project (ISS-12 or uuid), ' +
  'so the order can run after another requirement’s work; checked at create and at accept (SUGGESTION_PAYLOAD_INVALID for a BC ' +
  'the base revision lacks or a blocker cycle, SUGGESTION_BLOCKER_UNKNOWN, SUGGESTION_BLOCKER_TERMINAL), and accepting it files ' +
  'every issue at draft, linked, traced and edged, in one transaction; ' +
  'triage { note, priority?, category?, route? } on an issue; duplicate { duplicateOf, similarity?, note? }; ' +
  'feedback_triage on `feedback` (FB-n), baseRevision null: { route: issue | revision | new_requirement | answer | duplicate, issue? | createIssue? | suggestion? | requirement? | title? | answer? | duplicateOf?, kind?, severity?, note? }; accepting it writes the route (forge_feedback_items). ' +
  'accept { suggestionId, reason? } and reject { suggestionId, reason } are a person’s acts (SUGGESTION_ACCEPT_FORBIDDEN for an agent); ' +
  'an accept’s reason is kept on the suggestion, and is where the authority behind it is named. ' +
  'revise { suggestionId, payload, reason } is a reviewer’s edit: the original is rejected with the reason and a new suggestion ' +
  'carrying the whole new payload is proposed by the reviewer, naming the original (revises); the reviewer then cannot accept it ' +
  '(SUGGESTION_ACCEPT_FORBIDDEN), and its producer cannot revise its own (SUGGESTION_REVISE_FORBIDDEN, withdraw instead); ' +
  'an unchanged payload is SUGGESTION_REVISION_UNCHANGED. ' +
  'accepting a revision_diff writes a new DRAFT revision, never a current one. withdraw: the producer retracts its own. ' +
  'list: { requirement | issue, status? } answers each suggestion as { id, kind, status, target, baseRevision, revises, ' +
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
      const level = await dataPolicyOf(projectId);
      const rows =
        input.view === 'full'
          ? listed.suggestions.map((v) =>
              egressOr(
                egressAt(
                  level,
                  v.target.type === 'feedback' ? 'feedback' : 'suggestion',
                  v,
                  `suggestion ${v.id}`,
                ),
                { id: v.id, kind: v.kind, status: v.status, target: v.target },
              ),
            )
          : projectMany(input.view, listed.suggestions, suggestionSummaryOf);
      return {
        suggestions: rows,
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
        await acceptSuggestion({
          projectId,
          id: need(input, 'suggestionId'),
          actor,
          channel: 'mcp',
          reason: input.reason,
        }),
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
    case 'revise':
      return settle(
        input,
        await reviseSuggestion({
          projectId,
          id: need(input, 'suggestionId'),
          actor,
          payload: input.payload,
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
  route: '/api/projects',
  grant: GRANTS,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => run(args, ctx),
});
