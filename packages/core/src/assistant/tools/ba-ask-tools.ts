// The BA door's asks: one clarification question or one questionnaire card, at most one open per requirement.

import { randomUUID } from 'node:crypto';
import {
  POST_QUESTIONNAIRE_SHAPE,
  postQuestionnaireRequestSchema,
  QUESTIONNAIRE_DUE_DAYS,
  QUESTIONNAIRE_MAX_ROUNDS,
  type QuestionnaireRefusalCode,
} from '@forge/contracts/onboarding';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { questionnaireBatches } from '../../db/schema-onboarding.js';
import { agentQuestions } from '../../db/schema-questions.js';
import { lockXact } from '../../lib/advisory-lock.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { refuser } from '../../lib/refusal.js';
import { type ContextScopedMcpToolFactory, refusedAnswer } from '../../lib/tool.js';
import {
  announce,
  inTx,
  postQuestionnaireIn,
  roundsInConversation,
  roundsRefusal,
} from '../../questionnaires/index.js';
import { askQuestion } from '../../questions/index.js';
import { actorOf, type BaRoom, schema } from './ba-room.js';

export async function clarificationOf(requirementId: string) {
  const [q] = await db
    .select({ id: agentQuestions.id, status: agentQuestions.status, steps: agentQuestions.steps })
    .from(agentQuestions)
    .where(eq(agentQuestions.requirementId, requirementId))
    .orderBy(desc(agentQuestions.createdAt))
    .limit(1);
  if (!q) return null;
  const step = q.steps.at(-1);
  return {
    id: q.id,
    status: q.status,
    prompt: step?.prompt ?? null,
    answer: step && 'answerText' in step ? (step.answerText ?? null) : null,
  };
}

// the BA door asks through the same questionnaire card and submit as onboarding (BC-10): one
// batch is the one open ask a requirement holds (Q5), so it is refused over an open single question
// and a single question is refused over an open batch
export const sendQuestionnaire = (room: BaRoom): ContextScopedMcpToolFactory =>
  questionnaireTool(
    { projectId: room.projectId, requirementId: room.requirementId, firstRequirementsOf: null },
    `Ask the requirement owner several things at once as ONE questionnaire card they answer inline and send once (partial allowed). Shape: ${POST_QUESTIONNAIRE_SHAPE}. Use group "clarification" for vague criteria, "question" for missing facts, "recommendation" (control accept_reject) for a change you propose. At most one ask is open per requirement: a batch over an open clarification is CLARIFICATION_ALREADY_OPEN, a second batch QUESTIONNAIRE_ALREADY_OPEN; at most ${QUESTIONNAIRE_MAX_ROUNDS} rounds. Their answers arrive as their next message.`,
  );

/** project-onboarding `requirements`: the BA asks in the first-requirements room through the same card. */
export const sendFirstRequirementsQuestionnaire = (room: {
  projectId: string;
  onboardingId: string;
}): ContextScopedMcpToolFactory =>
  questionnaireTool(
    { projectId: room.projectId, requirementId: null, firstRequirementsOf: room.onboardingId },
    `Ask the person what the approved journeys leave open, as ONE questionnaire card they answer inline and send once (partial allowed), before or after suggesting. Shape: ${POST_QUESTIONNAIRE_SHAPE}. Use group "question" for a missing business fact, "clarification" for a vague journey step, "recommendation" (control accept_reject) for a requirement you would propose. One batch is open in the room at a time (QUESTIONNAIRE_ALREADY_OPEN); at most ${QUESTIONNAIRE_MAX_ROUNDS} rounds. It is due ${QUESTIONNAIRE_DUE_DAYS} days after it is sent; their answers arrive as their next message.`,
  );

interface QuestionnaireThread {
  projectId: string;
  requirementId: string | null;
  firstRequirementsOf: string | null;
}

const questionnaireTool =
  (thread: QuestionnaireThread, description: string): ContextScopedMcpToolFactory =>
  (ctx) => ({
    name: 'ba_send_questionnaire',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:write',
    description,
    inputSchema: schema(postQuestionnaireRequestSchema),
    handler: async (args) => {
      const body = postQuestionnaireRequestSchema.parse(args);
      const conversationId = ctx.turn?.conversationId;
      if (!conversationId) throw new Error('ba_send_questionnaire runs inside a BA room');
      const actor = actorOf(ctx);
      let batchId = '';
      let messageId: string | null = null;
      const refused = await inTx(async (tx) => {
        await lockXact(tx, 'questionnaire', conversationId);
        const sent = await roundsInConversation(tx, conversationId);
        const exhausted = roundsRefusal(sent);
        if (exhausted) return [exhausted];
        const posted = await postQuestionnaireIn(tx, {
          projectId: thread.projectId,
          conversationId,
          onboardingId: null,
          requirementId: thread.requirementId,
          firstRequirementsOf: thread.firstRequirementsOf,
          round: sent + 1,
          seriesSince: new Date(0),
          actor,
          authorLabel: 'BA assistant',
          title: body.title,
          intro: body.intro,
          items: body.items,
        });
        if (Array.isArray(posted)) return posted;
        batchId = posted.batchId;
        messageId = posted.messageId;
        return null;
      });
      if (refused) {
        return refusedAnswer(refused, 'ASSISTANT_REFUSED');
      }
      await announce(conversationId, messageId, 'assistant');
      return {
        questionnaire: { id: batchId, status: 'open' },
        note: 'The card is in the room; the person answers it inline and sends once.',
      };
    },
  });

async function openBatchOnRequirement(requirementId: string) {
  const [b] = await db
    .select({ id: questionnaireBatches.id })
    .from(questionnaireBatches)
    .where(
      and(
        eq(questionnaireBatches.requirementId, requirementId),
        inArray(questionnaireBatches.status, ['open', 'skipped']),
      ),
    )
    .limit(1);
  return b?.id ?? null;
}

const refuseAsk = refuser<QuestionnaireRefusalCode>('CLARIFICATION_ALREADY_OPEN');

const clarifyInput = z.strictObject({
  prompt: z.string().trim().min(5).max(2_000),
  needed: z.string().trim().min(3).max(1_000),
});

export const askClarification =
  (room: BaRoom): ContextScopedMcpToolFactory =>
  () => ({
    name: 'ba_ask_clarification',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:write',
    description:
      'Ask the requirement owner ONE clarification question (a repro step, a screenshot, an environment). `needed` says what would settle it. At most one question is open per requirement; a second is refused CLARIFICATION_ALREADY_OPEN.',
    inputSchema: schema(clarifyInput),
    handler: async (args) => {
      const input = clarifyInput.parse(args);
      const batch = await openBatchOnRequirement(room.requirementId);
      if (batch) {
        throw refuseAsk(
          'CLARIFICATION_ALREADY_OPEN',
          `questionnaire ${batch} is still open on this requirement; at most one ask is open per item — wait for its answers.`,
        );
      }
      try {
        const q = await askQuestion({
          id: randomUUID(),
          projectId: room.projectId,
          requirementId: room.requirementId,
          prompt: input.prompt,
          blockerKind: 'human',
          answer: { shape: 'free_text', needed: input.needed },
        });
        return { question: { id: q.id, status: q.status } };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const open = await clarificationOf(room.requirementId);
        throw refuseAsk(
          'CLARIFICATION_ALREADY_OPEN',
          `question ${open?.id ?? '(unknown)'} is still open on this requirement; at most one is open per item — wait for its answer.`,
        );
      }
    },
  });
