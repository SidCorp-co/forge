// The BA door's asks: clarification questions, and a questionnaire card the person answers inline.

import { randomUUID } from 'node:crypto';
import {
  POST_QUESTIONNAIRE_SHAPE,
  postQuestionnaireRequestSchema,
  QUESTIONNAIRE_DUE_DAYS,
} from '@forge/contracts/onboarding';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { agentQuestions } from '../../db/schema-questions.js';
import { lockXact } from '../../lib/advisory-lock.js';
import { type ContextScopedMcpToolFactory, refusedAnswer } from '../../lib/tool.js';
import {
  announce,
  inTx,
  postQuestionnaireIn,
  roundsInConversation,
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

// the BA door asks through the same questionnaire card and submit as onboarding (BC-10); a
// clarification question is asked beside an open card, never held behind it (REQ-65 r3 BC-3)
export const sendQuestionnaire = (room: BaRoom): ContextScopedMcpToolFactory =>
  questionnaireTool(
    { projectId: room.projectId, requirementId: room.requirementId, firstRequirementsOf: null },
    `Ask the requirement owner several things at once as ONE questionnaire card they answer inline and send once (partial allowed). Shape: ${POST_QUESTIONNAIRE_SHAPE}. Use group "clarification" for vague criteria, "question" for missing facts, "recommendation" (control accept_reject) for a change you propose. A card sent while another still waits is refused QUESTIONNAIRE_ALREADY_OPEN: ask the rest in the next round, or as clarification questions. Their answers arrive as their next message.`,
  );

/** project-onboarding `requirements`: the BA asks in the first-requirements room through the same card. */
export const sendFirstRequirementsQuestionnaire = (room: {
  projectId: string;
  onboardingId: string;
}): ContextScopedMcpToolFactory =>
  questionnaireTool(
    { projectId: room.projectId, requirementId: null, firstRequirementsOf: room.onboardingId },
    `Ask the person what the approved journeys leave open, as ONE questionnaire card they answer inline and send once (partial allowed), before or after suggesting. Shape: ${POST_QUESTIONNAIRE_SHAPE}. Use group "question" for a missing business fact, "clarification" for a vague journey step, "recommendation" (control accept_reject) for a requirement you would propose. A card sent while another still waits is refused QUESTIONNAIRE_ALREADY_OPEN: ask the rest in the next round. It is due ${QUESTIONNAIRE_DUE_DAYS} days after it is sent; their answers arrive as their next message.`,
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
      'Ask the requirement owner one clarification question (a repro step, a screenshot, an environment); each is its own open question on the requirement. `needed` says what would settle it. A business question the next revision must settle goes in that revision as spec.openQuestions instead (ba_suggest), where it can block the agree. Ask the questions you need, beside an open questionnaire card or not.',
    inputSchema: schema(clarifyInput),
    handler: async (args) => {
      const input = clarifyInput.parse(args);
      const q = await askQuestion({
        id: randomUUID(),
        projectId: room.projectId,
        requirementId: room.requirementId,
        prompt: input.prompt,
        blockerKind: 'human',
        answer: { shape: 'free_text', needed: input.needed },
      });
      return { question: { id: q.id, status: q.status } };
    },
  });
