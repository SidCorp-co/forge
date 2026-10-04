/**
 * `forge_onboarding` — the agent's door into workflow project-onboarding: post a questionnaire
 * batch, read what the person answered, post an update naming designs, mark onboarding done. Start,
 * re-analysis and answering are a person's acts and live on REST only; the services are the same
 * ones `onboarding/routes.ts` calls.
 */

import {
  POST_QUESTIONNAIRE_SHAPE,
  POST_UPDATE_SHAPE,
  postQuestionnaireRequestSchema,
  postUpdateRequestSchema,
} from '@forge/contracts/onboarding';
import { z } from 'zod';
import { MCP_DOOR } from '../../lib/data-egress.js';
import {
  markOnboardingDone,
  type OnboardingActor,
  postOnboardingQuestionnaire,
  postOnboardingUpdate,
  readAnswers,
} from '../../onboarding/service.js';
import type { NamedRefusal } from '../../project-config/respond.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalAgency,
  refusedAnswer,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const ACTIONS = ['post_questionnaire', 'read_answers', 'post_update', 'mark_done'] as const;

const inputSchema = z.strictObject({
  action: z.enum(ACTIONS),
  projectId: z.uuid().optional(),
  questionnaire: z.unknown().optional(),
  update: z.unknown().optional(),
  text: z.string().max(8_000).optional(),
});

type Input = z.infer<typeof inputSchema>;

const write = 'projects:write';
const GRANTS = {
  byAction: {
    post_questionnaire: write,
    read_answers: 'projects:read',
    post_update: write,
    mark_done: write,
  },
} as const;

const DESCRIPTION =
  'Onboarding (workflow project-onboarding): the thread in the chat panel where the project agent ' +
  `agrees the key designs with a person. Actions: ${ACTIONS.join(' | ')}. ` +
  `post_questionnaire: { questionnaire: ${POST_QUESTIONNAIRE_SHAPE} } — one batch answered once; ` +
  'a second open batch is QUESTIONNAIRE_ALREADY_OPEN, a 4th round QUESTIONNAIRE_ROUNDS_EXHAUSTED, an ' +
  'item answered before QUESTIONNAIRE_ITEM_ANSWERED_BEFORE, a rejected recommendation ' +
  'QUESTIONNAIRE_RECOMMENDATION_REJECTED, a malformed item QUESTIONNAIRE_ITEM_INVALID. ' +
  'read_answers: every batch of the thread with each item’s state (open / answered / void) and answer. ' +
  `post_update: { update: ${POST_UPDATE_SHAPE} } — a message in the thread; designs it names are ` +
  'registered with the onboarding and take only a person’s approval. mark_done: { text? } — refused ' +
  'ONBOARDING_DATA_FLOW_MISSING on a sensitive-data project with no data-flow design. Start, ' +
  're-analysis and answering are a person’s acts (REST).';

function need<K extends keyof Input>(input: Input, key: K): NonNullable<Input[K]> {
  const value = input[key];
  if (value === undefined || value === null) {
    throw new Error(`BAD_REQUEST: ${input.action} needs \`${String(key)}\``);
  }
  return value as NonNullable<Input[K]>;
}

const refusedBy = (refusals: readonly NamedRefusal[]) =>
  refusedAnswer(refusals, 'ONBOARDING_REFUSED');

function parsed<T extends z.ZodType>(schema: T, value: unknown, shape: string): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new Error(
      `BAD_REQUEST: invalid body: ${shape}; ${first ? `${first.path.join('/') || '/'}: ${first.message}` : ''}`,
    );
  }
  return r.data;
}

async function run(args: unknown, ctx: McpContext): Promise<unknown> {
  const input = inputSchema.parse(args);
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  const actor: OnboardingActor = {
    userId: ctx.principal.userId,
    agency: principalAgency(ctx.principal),
  };
  switch (input.action) {
    case 'post_questionnaire': {
      const outcome = await postOnboardingQuestionnaire({
        projectId,
        actor,
        body: parsed(
          postQuestionnaireRequestSchema,
          need(input, 'questionnaire'),
          POST_QUESTIONNAIRE_SHAPE,
        ),
      });
      return outcome.ok ? { questionnaire: outcome.questionnaire } : refusedBy(outcome.refusals);
    }
    case 'read_answers': {
      const outcome = await readAnswers(projectId, { ...actor, ...MCP_DOOR });
      return outcome.ok
        ? { onboarding: outcome.onboarding, questionnaires: outcome.questionnaires }
        : refusedBy(outcome.refusals);
    }
    case 'post_update': {
      const outcome = await postOnboardingUpdate({
        projectId,
        actor,
        body: parsed(postUpdateRequestSchema, need(input, 'update'), POST_UPDATE_SHAPE),
      });
      return outcome.ok ? { onboarding: outcome.onboarding } : refusedBy(outcome.refusals);
    }
    case 'mark_done': {
      const outcome = await markOnboardingDone({ projectId, actor, text: input.text });
      return outcome.ok ? { onboarding: outcome.onboarding } : refusedBy(outcome.refusals);
    }
  }
}

export const forgeOnboardingTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_onboarding',
  reach: 'project',
  grant: GRANTS,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => run(args, ctx),
});
