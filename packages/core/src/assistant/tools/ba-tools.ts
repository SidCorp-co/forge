/**
 * The BA door's tool set (ISS-58): read the room's requirement, an issue and similar requirements;
 * write a suggestion; ask one clarification; propose a wireframe mockup (ISS-78). It is the whole catalog a BA turn is offered — no
 * forge CLI, no requirement or issue write — so the role's bound is what the model can call, not
 * what its prompt asks of it. The requirement is bound when the toolset is built, from the room.
 */

import { randomUUID } from 'node:crypto';
import {
  POST_QUESTIONNAIRE_SHAPE,
  postQuestionnaireRequestSchema,
  QUESTIONNAIRE_MAX_ROUNDS,
  type QuestionnaireRefusalCode,
} from '@forge/contracts/onboarding';
import { SUGGESTION_KINDS } from '@forge/contracts/suggestions';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { conversationMessages } from '../../db/schema-conversations.js';
import { itemEmbeddings } from '../../db/schema-item-embeddings.js';
import { questionnaireBatches } from '../../db/schema-onboarding.js';
import { agentQuestions } from '../../db/schema-questions.js';
import { defaultChatProviderId, resolveForProject } from '../../integrations/llm/index.js';
import { principalAgency } from '../../issues/index.js';
import { resolveIssueRouteRef } from '../../issues/issue-route-ref.js';
import { dataPolicyOf, egressAt, egressDeep, egressOr, MCP_DOOR } from '../../lib/data-egress.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { refuser } from '../../lib/refusal.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  refusedAnswer,
} from '../../lib/tool.js';
import { roundsInConversation } from '../../questionnaires/read.js';
import { roundsRefusal } from '../../questionnaires/rules.js';
import { announce, inTx, postQuestionnaireIn } from '../../questionnaires/service.js';
import { askQuestion } from '../../questions/write.js';
import { similarRequirements } from '../../requirements/embeddings.js';
import { readRequirementAs } from '../../requirements/read.js';
import { listSuggestions } from '../../suggestions/read.js';
import { createSuggestion } from '../../suggestions/service.js';
import { drawMockup } from './ba-mockup-tool.js';
import { buildToolset, type ChatToolset } from './mcp-adapter.js';
import { lockXact } from '../../lib/advisory-lock.js';

export interface BaRoom {
  projectId: string;
  requirementId: string;
}

const schema = (s: z.ZodType) => z.toJSONSchema(s) as Record<string, unknown>;

function actorOf(ctx: McpContext) {
  return { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) };
}

async function clarificationOf(requirementId: string) {
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

const readRequirement =
  (room: BaRoom): ContextScopedMcpToolFactory =>
  (ctx) => ({
    name: 'ba_read_requirement',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:read',
    description:
      'Read the requirement this room is about: its revisions (newest first) with criteria, the head (currentRevision), the suggestions waiting on it, the latest clarification question and its answer, and whether its head is embedded for dedup.',
    inputSchema: schema(z.strictObject({})),
    handler: async () => {
      const detail = await readRequirementAs(
        actorOf(ctx),
        room.projectId,
        room.requirementId,
        MCP_DOOR,
      );
      const [waiting, clarification, embedding] = await Promise.all([
        listSuggestions({
          projectId: room.projectId,
          userId: ctx.principal.userId,
          target: { requirement: room.requirementId },
          statuses: ['proposed', 'rejected'],
          limit: 20,
        }),
        clarificationOf(room.requirementId),
        db
          .select({ status: itemEmbeddings.status, version: itemEmbeddings.version })
          .from(itemEmbeddings)
          .where(eq(itemEmbeddings.requirementId, room.requirementId)),
      ]);
      const level = await dataPolicyOf(room.projectId);
      const requirement = egressOr(egressAt(level, 'requirement', detail, detail.key), {
        key: detail.key,
        status: detail.status,
        currentRevision: detail.currentRevision,
      });
      const suggestions = egressOr(
        egressAt(
          level,
          'suggestion',
          waiting.suggestions.map((s) => ({
            id: s.id,
            kind: s.kind,
            status: s.status,
            baseRevision: s.baseRevision,
            reason: s.reason,
          })),
          `the suggestions on ${detail.key}`,
        ),
        { ids: waiting.suggestions.map((s) => s.id) },
      );
      const asked = clarification
        ? egressOr(
            egressAt(
              level,
              'requirement.clarification',
              clarification,
              `the clarification on ${detail.key}`,
            ),
            { id: clarification.id, status: clarification.status },
          )
        : null;
      return {
        requirement,
        suggestions,
        openSuggestions: waiting.open,
        clarification: asked,
        embedding: embedding[0] ?? { status: 'none', version: null },
      };
    },
  });

const readIssue =
  (room: BaRoom): ContextScopedMcpToolFactory =>
  (ctx) => ({
    name: 'ba_read_issue',
    reach: 'project',
    route: '/api/issues',
    grant: 'issues:read',
    description:
      'Read one issue of this project by key (ISS-12) or id: title, status, description, acceptance criteria.',
    inputSchema: schema(z.strictObject({ issue: z.string().min(1).max(200) })),
    handler: async (args) => {
      const { issue } = z.strictObject({ issue: z.string().min(1).max(200) }).parse(args);
      const row = await resolveIssueRouteRef(issue, room.projectId, ctx.principal.userId);
      if (row.projectId !== room.projectId)
        throw new Error(`${issue} is not an issue of this project`);
      const answer = {
        id: row.id,
        title: row.title,
        status: row.status,
        priority: row.priority,
        category: row.category,
        description: (row.description ?? '').slice(0, 8_000),
        acceptanceCriteria: (row.acceptanceCriteria ?? '').slice(0, 8_000),
        requirementId: row.requirementId,
      };
      return egressOr(await egressDeep(room.projectId, 'issue', answer, issue), {
        id: row.id,
        status: row.status,
        priority: row.priority,
        category: row.category,
        requirementId: row.requirementId,
      });
    },
  });

const findSimilar =
  (room: BaRoom): ContextScopedMcpToolFactory =>
  () => ({
    name: 'ba_find_similar',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:read',
    description:
      "Find this project's requirements most similar to a text (dedup). Answers status provider_not_configured when no embedding provider is set, or withheld_by_policy when the text, which comes from a conversation with a person, may not leave on a no_egress project — then say so; it does not mean none are similar.",
    inputSchema: schema(z.strictObject({ text: z.string().trim().min(3).max(8_000) })),
    handler: async (args) => {
      const { text } = z.strictObject({ text: z.string().trim().min(3).max(8_000) }).parse(args);
      return similarRequirements(room.projectId, text, 'conversation');
    },
  });

const suggestInput = z.strictObject({
  kind: z.enum(SUGGESTION_KINDS),
  baseRevision: z.number().int().min(1).nullable(),
  payload: z.record(z.string(), z.unknown()),
  issue: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Only for a kind that targets an issue (requirement_draft, triage, duplicate of an issue).',
    ),
});

async function latestMessageId(conversationId: string | null | undefined): Promise<string | null> {
  if (!conversationId) return null;
  const [m] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, conversationId)))
    .orderBy(desc(conversationMessages.seq))
    .limit(1);
  return m?.id ?? null;
}

async function modelFor(projectId: string): Promise<string | null> {
  try {
    return (await resolveForProject(projectId, { fallbackProviderId: defaultChatProviderId(), db }))
      .model;
  } catch {
    return null;
  }
}

const suggest =
  (room: BaRoom): ContextScopedMcpToolFactory =>
  (ctx) => ({
    name: 'ba_suggest',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:write',
    description:
      'Propose a change for a person to accept or reject. kind revision_diff: payload { reason, spec?, tldr?, changeSummary?, criteria: [{ code?, body, form? }] } — the whole criteria list of the new revision (a live code keeps it, no code takes the next, one left out is retired). readiness: { checks: [{ check, passed, detail? }] }. A breakdown takes suggestions.write (PERMISSION_FORBIDDEN without it). duplicate: { duplicateOf, similarity?, note? }. requirement_draft / triage target an issue (pass `issue`). baseRevision is the currentRevision you read (null when there is none).',
    inputSchema: schema(suggestInput),
    handler: async (args) => {
      const input = suggestInput.parse(args);
      const outcome = await createSuggestion({
        projectId: room.projectId,
        actor: actorOf(ctx),
        producerKind: 'ba_assistant',
        producerId: ctx.turn?.handleUserId ?? null,
        kind: input.kind,
        target: input.issue ? { issue: input.issue } : { requirement: room.requirementId },
        baseRevision: input.baseRevision,
        payload: input.payload,
        model: await modelFor(room.projectId),
        conversationMessageId: await latestMessageId(ctx.turn?.conversationId),
      });
      if (!outcome.ok) {
        return refusedAnswer(outcome.refusals, 'ASSISTANT_REFUSED');
      }
      return {
        suggestion: {
          id: outcome.suggestion.id,
          kind: outcome.suggestion.kind,
          status: 'proposed',
        },
        note: 'Waiting on a person to accept or reject it on the requirement page.',
      };
    },
  });

// cm:why the BA door asks through the same questionnaire card and submit as onboarding (BC-10): one
// batch is the one open ask a requirement holds (Q5), so it is refused over an open single question
// and a single question is refused over an open batch
const sendQuestionnaire =
  (room: BaRoom): ContextScopedMcpToolFactory =>
  (ctx) => ({
    name: 'ba_send_questionnaire',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:write',
    description: `Ask the requirement owner several things at once as ONE questionnaire card they answer inline and send once (partial allowed). Shape: ${POST_QUESTIONNAIRE_SHAPE}. Use group "clarification" for vague criteria, "question" for missing facts, "recommendation" (control accept_reject) for a change you propose. At most one ask is open per requirement: a batch over an open clarification is CLARIFICATION_ALREADY_OPEN, a second batch QUESTIONNAIRE_ALREADY_OPEN; at most ${QUESTIONNAIRE_MAX_ROUNDS} rounds. Their answers arrive as their next message.`,
    inputSchema: schema(postQuestionnaireRequestSchema),
    handler: async (args) => {
      const body = postQuestionnaireRequestSchema.parse(args);
      const conversationId = ctx.turn?.conversationId;
      if (!conversationId) throw new Error('ba_send_questionnaire runs inside a requirement room');
      const actor = actorOf(ctx);
      let batchId = '';
      let messageId: string | null = null;
      const refused = await inTx(async (tx) => {
        await lockXact(tx, 'questionnaire', conversationId);
        const sent = await roundsInConversation(tx, conversationId);
        const exhausted = roundsRefusal(sent);
        if (exhausted) return [exhausted];
        const posted = await postQuestionnaireIn(tx, {
          projectId: room.projectId,
          conversationId,
          onboardingId: null,
          requirementId: room.requirementId,
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

const askClarification =
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

/** The BA door's whole catalog, bound to the room's requirement. */
export function buildBaToolset(ctx: McpContext, room: BaRoom): ChatToolset {
  return buildToolset(ctx, [
    { factory: readRequirement(room) },
    { factory: readIssue(room) },
    { factory: findSimilar(room) },
    { factory: suggest(room) },
    { factory: askClarification(room) },
    { factory: sendQuestionnaire(room) },
    { factory: drawMockup(room) },
  ]);
}

export const BA_TOOL_NAMES = [
  'ba_read_requirement',
  'ba_read_issue',
  'ba_find_similar',
  'ba_suggest',
  'ba_ask_clarification',
  'ba_send_questionnaire',
  'ba_draw_mockup',
] as const;
