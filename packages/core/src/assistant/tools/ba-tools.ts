/**
 * The BA door's tool set (ISS-58): read the room's requirement, an issue and similar requirements;
 * write a suggestion; ask one clarification. It is the whole catalog a BA turn is offered — no
 * forge CLI, no requirement or issue write — so the role's bound is what the model can call, not
 * what its prompt asks of it. The requirement is bound when the toolset is built, from the room.
 */

import { randomUUID } from 'node:crypto';
import { SUGGESTION_KINDS } from '@forge/contracts/suggestions';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { conversationMessages } from '../../db/schema-conversations.js';
import { itemEmbeddings } from '../../db/schema-item-embeddings.js';
import { agentQuestions } from '../../db/schema-questions.js';
import { resolveIssueRouteRef } from '../../issues/issue-route-ref.js';
import { dataPolicyOf, egressDeep } from '../../lib/data-egress.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalAgency,
} from '../../mcp/tools/lib.js';
import { askQuestion } from '../../questions/write.js';
import { similarRequirements } from '../../requirements/embeddings.js';
import { readRequirementAs } from '../../requirements/read.js';
import { listSuggestions } from '../../suggestions/read.js';
import { createSuggestion } from '../../suggestions/service.js';
import { defaultChatProviderId } from '../providers/bootstrap.js';
import { resolveForProject } from '../providers/registry.js';
import { buildToolset, type ChatToolset } from './mcp-adapter.js';

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
    grant: 'projects:read',
    description:
      'Read the requirement this room is about: its revisions (newest first) with criteria, the head (currentRevision), the suggestions waiting on it, the latest clarification question and its answer, and whether its head is embedded for dedup.',
    inputSchema: schema(z.strictObject({})),
    handler: async () => {
      const detail = await readRequirementAs(actorOf(ctx), room.projectId, room.requirementId);
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
      const answer = {
        requirement: detail,
        suggestions: waiting.suggestions.map((s) => ({
          id: s.id,
          kind: s.kind,
          status: s.status,
          baseRevision: s.baseRevision,
          reason: s.reason,
        })),
        openSuggestions: waiting.open,
        clarification,
        embedding: embedding[0] ?? { status: 'none', version: null },
      };
      const out = egressDeep(await dataPolicyOf(room.projectId), answer, detail.key);
      if (out.ok) return out.value;
      return {
        withheld: out.refusal,
        requirement: {
          key: detail.key,
          status: detail.status,
          currentRevision: detail.currentRevision,
          revisions: detail.revisions.map((r) => ({
            revision: r.revision,
            state: r.state,
            criteria: r.criteria.map((c) => c.code),
          })),
        },
        suggestions: answer.suggestions.map((s) => ({ id: s.id, kind: s.kind, status: s.status })),
        openSuggestions: answer.openSuggestions,
        clarification: clarification
          ? { id: clarification.id, status: clarification.status }
          : null,
        embedding: answer.embedding,
      };
    },
  });

const readIssue =
  (room: BaRoom): ContextScopedMcpToolFactory =>
  (ctx) => ({
    name: 'ba_read_issue',
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
      const out = egressDeep(await dataPolicyOf(room.projectId), answer, issue);
      if (out.ok) return out.value;
      return {
        withheld: out.refusal,
        id: row.id,
        status: row.status,
        priority: row.priority,
        category: row.category,
        requirementId: row.requirementId,
      };
    },
  });

const findSimilar =
  (room: BaRoom): ContextScopedMcpToolFactory =>
  () => ({
    name: 'ba_find_similar',
    grant: 'projects:read',
    description:
      "Find this project's requirements most similar to a text (dedup). Answers status provider_not_configured when no embedding provider is set, or withheld_by_policy on a no_egress project — then say so; it does not mean none are similar.",
    inputSchema: schema(z.strictObject({ text: z.string().trim().min(3).max(8_000) })),
    handler: async (args) => {
      const { text } = z.strictObject({ text: z.string().trim().min(3).max(8_000) }).parse(args);
      return similarRequirements(room.projectId, text);
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
    grant: 'projects:write',
    description:
      'Propose a change for a person to accept or reject. kind revision_diff: payload { reason, spec?, tldr?, changeSummary?, criteria: [{ code?, body, form? }] } — the whole criteria list of the new revision (a live code keeps it, no code takes the next, one left out is retired). readiness: { checks: [{ check, passed, detail? }] }. breakdown: { issues: [{ title, description?, criteria?: [{ body, tracesTo? }] }], uncovered? }. duplicate: { duplicateOf, similarity?, note? }. requirement_draft / triage target an issue (pass `issue`). baseRevision is the currentRevision you read (null when there is none).',
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
        throw new Error(
          `${outcome.refusals.map((r) => `${r.code}: ${r.detail}`).join(' | ')} — nothing was written`,
        );
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

const clarifyInput = z.strictObject({
  prompt: z.string().trim().min(5).max(2_000),
  needed: z.string().trim().min(3).max(1_000),
});

const askClarification =
  (room: BaRoom): ContextScopedMcpToolFactory =>
  () => ({
    name: 'ba_ask_clarification',
    grant: 'projects:write',
    description:
      'Ask the requirement owner ONE clarification question (a repro step, a screenshot, an environment). `needed` says what would settle it. At most one question is open per requirement; a second is refused CLARIFICATION_ALREADY_OPEN.',
    inputSchema: schema(clarifyInput),
    handler: async (args) => {
      const input = clarifyInput.parse(args);
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
        throw new Error(
          `CLARIFICATION_ALREADY_OPEN: question ${open?.id ?? '(unknown)'} is still open on this requirement; at most one is open per item — wait for its answer.`,
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
  ]);
}

export const BA_TOOL_NAMES = [
  'ba_read_requirement',
  'ba_read_issue',
  'ba_find_similar',
  'ba_suggest',
  'ba_ask_clarification',
] as const;
