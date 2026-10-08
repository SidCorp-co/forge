/**
 * The BA door's tool set (ISS-58): read the room's requirement, an issue and similar requirements;
 * write a suggestion; ask a clarification; propose a wireframe mockup (ISS-78). It is the whole catalog a BA turn is offered — no
 * forge CLI, no requirement or issue write — so the role's bound is what the model can call, not
 * what its prompt asks of it. The requirement is bound when the toolset is built, from the room.
 */

import { SUGGESTION_KINDS } from '@forge/contracts/suggestions';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { conversationMessages } from '../../db/schema-conversations.js';
import { itemEmbeddings } from '../../db/schema-item-embeddings.js';
import { chatModelName } from '../../integrations/llm/index.js';
import { resolveIssueRouteRef } from '../../issues/index.js';
import { dataPolicyOf, egressAt, egressDeep, egressOr, MCP_DOOR } from '../../lib/data-egress.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  refusedAnswer,
} from '../../lib/tool.js';
import { readRequirementAs, similarRequirements } from '../../requirements/index.js';
import { createSuggestion, listSuggestions, suggestionBaseOf } from '../../suggestions/index.js';
import { askClarification, clarificationOf, sendQuestionnaire } from './ba-ask-tools.js';
import { drawMockup } from './ba-mockup-tool.js';
import { actorOf, type BaRoom, schema } from './ba-room.js';
import { buildToolset, type ChatToolset } from './mcp-adapter.js';

/**
 * What this turn's ba_read_requirement returned, which ba_suggest bases its suggestion on: the
 * model never types a base (forge-dev 0.4.0-dev.193, REQ-31 and REQ-36: it sent the draft it had
 * read, 1, and was refused SUGGESTION_BASE_STALE against "no revision"). The toolset is built per
 * turn, so this is the turn's read; unread, the server reads the base at creation.
 */
interface TurnRead {
  head: number | null;
  open: number | null;
}

const readRequirement =
  (room: BaRoom, seen: { read: TurnRead | null }): ContextScopedMcpToolFactory =>
  (ctx) => ({
    name: 'ba_read_requirement',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:read',
    description:
      'Read the requirement this room is about: its revisions (newest first) with criteria and spec (open questions and assumptions included), the head (currentRevision), the questions standing on it (`questions`, open first, with who answers and whether each blocks the agree; `unclear` counts the open ones), the suggestions waiting on it, the latest clarification question and its answer, and whether its head is embedded for dedup.',
    inputSchema: schema(z.strictObject({})),
    handler: async () => {
      const detail = await readRequirementAs(
        actorOf(ctx),
        room.projectId,
        room.requirementId,
        MCP_DOOR,
      );
      const latest = detail.latestRevision;
      seen.read = {
        head: detail.currentRevision,
        open:
          latest && (latest.state === 'draft' || latest.state === 'proposed')
            ? latest.revision
            : null,
      };
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

function chatModel(): string | null {
  try {
    return chatModelName();
  } catch {
    return null;
  }
}

const suggest =
  (room: BaRoom, seen: { read: TurnRead | null }): ContextScopedMcpToolFactory =>
  (ctx) => ({
    name: 'ba_suggest',
    reach: 'project',
    route: '/api/projects',
    grant: 'projects:write',
    description:
      'Propose a change for a person to accept or reject; its base is the requirement as you read it this turn. Each kind takes its own payload. revision_diff: { reason, spec?, tldr?, changeSummary?, criteria: [{ code?, body, form? }] }, the WHOLE criteria list: a kept or reworded criterion names its live code, a new one carries no code (Forge numbers it), an unknown code is refused (CRITERION_CODE_UNKNOWN), a live one left out is retired; spec.openQuestions [{ question, whoAnswers, blocking }] and spec.assumptions [{ text, owner, confirmBy }] hold what is unsettled or unproven. On a requirement with an open draft or proposed revision it rewrites that revision. readiness: { checks: [{ check, passed, detail? }] }, a kind of its own, never a key of revision_diff. duplicate: { duplicateOf, similarity?, note? }. breakdown needs suggestions.write. requirement_draft and triage target an issue: pass `issue`.',
    inputSchema: schema(suggestInput),
    handler: async (args) => {
      const input = suggestInput.parse(args);
      const read = seen.read;
      const baseRevision = input.issue
        ? null
        : read
          ? input.kind === 'revision_diff'
            ? (read.open ?? read.head)
            : read.head
          : await suggestionBaseOf(room.projectId, room.requirementId, input.kind);
      const outcome = await createSuggestion({
        projectId: room.projectId,
        actor: actorOf(ctx),
        producerKind: 'ba_assistant',
        producerId: ctx.turn?.handleUserId ?? null,
        kind: input.kind,
        target: input.issue ? { issue: input.issue } : { requirement: room.requirementId },
        baseRevision,
        payload: input.payload,
        model: chatModel(),
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
          baseRevision: outcome.suggestion.baseRevision,
        },
        note: 'Waiting on a person to accept or reject it on the requirement page.',
      };
    },
  });

/** The BA door's whole catalog, bound to the room's requirement. */
export function buildBaToolset(ctx: McpContext, room: BaRoom): ChatToolset {
  const seen: { read: TurnRead | null } = { read: null };
  return buildToolset(ctx, [
    { factory: readRequirement(room, seen) },
    { factory: readIssue(room) },
    { factory: findSimilar(room) },
    { factory: suggest(room, seen) },
    { factory: askClarification(room) },
    { factory: sendQuestionnaire(room) },
    { factory: drawMockup(room) },
  ]);
}
