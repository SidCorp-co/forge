/**
 * The BA door's tool set in a first-requirements case room (workflow project-onboarding steps
 * `requirements` and `suggested`): read the approved onboarding journeys, look for similar
 * requirements, suggest one requirement per journey, and ask through the questionnaire card.
 * Accepting a suggestion is a person's act.
 */

import { REASON_TEXT_MAX } from '@forge/contracts/comments';
import { requirementCriterionSchema, requirementSpecSchema } from '@forge/contracts/suggestions';
import { z } from 'zod';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  refusedAnswer,
} from '../../lib/tool.js';
import { firstRequirementsJourneys } from '../../onboarding/index.js';
import { similarRequirements } from '../../requirements/index.js';
import { createSuggestion } from '../../suggestions/index.js';
import { sendFirstRequirementsQuestionnaire } from './ba-ask-tools.js';
import { actorOf, schema } from './ba-room.js';
import { buildToolset, type ChatToolset } from './mcp-adapter.js';

interface CaseRoom {
  projectId: string;
  onboardingId: string;
}

const readJourneys =
  (room: CaseRoom): ContextScopedMcpToolFactory =>
  () => ({
    name: 'ba_read_journeys',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:read',
    description:
      "Read the designs onboarding drafted: each one's id, flow, title, design status, approved revision, steps (id, label, does) and the requirement drafts already suggested on it. Draft only from designs whose designStatus is approved.",
    inputSchema: schema(z.strictObject({})),
    handler: async () => ({ journeys: await firstRequirementsJourneys(room.projectId) }),
  });

const findSimilar =
  (room: CaseRoom): ContextScopedMcpToolFactory =>
  () => ({
    name: 'ba_find_similar',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:read',
    description:
      "Find this project's requirements most similar to a text (dedup). provider_not_configured or withheld_by_policy does not mean none are similar; say so.",
    inputSchema: schema(z.strictObject({ text: z.string().trim().min(3).max(8_000) })),
    handler: async (args) => {
      const { text } = z.strictObject({ text: z.string().trim().min(3).max(8_000) }).parse(args);
      return similarRequirements(room.projectId, text, 'conversation');
    },
  });

const suggestRequirementInput = z.strictObject({
  journey: z.uuid().describe('The approved design (workflowId) this requirement is drawn from.'),
  title: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(REASON_TEXT_MAX),
  spec: requirementSpecSchema.optional(),
  tldr: z.string().max(4_000).nullable().optional(),
  criteria: z.array(requirementCriterionSchema).min(1).max(200),
  designs: z
    .array(z.uuid())
    .max(20)
    .optional()
    .describe('Other approved designs the requirement serves beside its journey.'),
});

const suggestRequirement =
  (room: CaseRoom): ContextScopedMcpToolFactory =>
  (ctx) => ({
    name: 'ba_suggest_requirement',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:write',
    description:
      'Suggest one first requirement for one approved journey: title, reason, business criteria (statements by default) and the other approved designs it serves. One per journey: a second is SUGGESTION_JOURNEY_SUGGESTED; a design not approved is SUGGESTION_DESIGN_NOT_APPROVED, one not in the project SUGGESTION_DESIGN_UNKNOWN. A person accepts it, which creates the requirement linked to those designs.',
    inputSchema: schema(suggestRequirementInput),
    handler: async (args) => {
      const { journey, ...payload } = suggestRequirementInput.parse(args);
      const outcome = await createSuggestion({
        projectId: room.projectId,
        actor: actorOf(ctx),
        producerKind: 'ba_assistant',
        producerId: ctx.turn?.handleUserId ?? null,
        kind: 'requirement_draft',
        target: { workflow: journey },
        baseRevision: null,
        payload,
      });
      if (!outcome.ok) return refusedAnswer(outcome.refusals, 'ASSISTANT_REFUSED');
      return {
        suggestion: { id: outcome.suggestion.id, kind: 'requirement_draft', status: 'proposed' },
        note: 'Waiting on a person to accept or reject it.',
      };
    },
  });

/** The first-requirements case room's whole catalog, bound to its project. */
export function buildBaFirstRequirementsToolset(ctx: McpContext, room: CaseRoom): ChatToolset {
  return buildToolset(ctx, [
    { factory: readJourneys(room) },
    { factory: findSimilar(room) },
    { factory: suggestRequirement(room) },
    { factory: sendFirstRequirementsQuestionnaire(room) },
  ]);
}
