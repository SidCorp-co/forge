/**
 * ISS-604 (P2a) — non-streaming chat entrypoint for external channels (Rocket.Chat, Telegram, …):
 * the same resolution as the SSE `/api/chat` route, but the shared turn loop is drained to one
 * reply string. The caller supplies the toolset (it owns the principal); none means a tool-less
 * completion.
 *
 * A turn either belongs to a conversation — named by its id, or by the venue it
 * happens in — or belongs to none, which is what a one-shot relay is. The audit
 * row is written either way.
 */

import { eq } from 'drizzle-orm';
import { readAssistantPreferences } from '../auth/preference-changes.js';
import { env } from '../config/env.js';
import { db as defaultDb } from '../db/client.js';
import { appConfig, chatLogs, projects } from '../db/schema.js';
import type { ConversationAdapter, ConversationShape } from '../db/schema-conversations.js';
import {
  buildProgressFactsBlock,
  computeProjectProgress,
  type ProjectProgress,
} from '../issues/progress.js';
import { logger } from '../logger.js';
import { readSelvesFor } from '../orgs/agent-selves.js';
import { detectStateConfab } from './confab.js';
import { PROVIDER_HISTORY_WINDOW } from './context-budget.js';
import {
  appendAssistantMessage,
  appendSilence,
  appendUserMessage,
  type ConversationTurn,
  openTurn,
  persistMessages,
  toProviderMessages,
} from './conversation-turn.js';
import { speakerSection } from './preference-line.js';
import { defaultChatProviderId } from './providers/bootstrap.js';
import { type ChatTurnKind, resolveForProject } from './providers/registry.js';
import type { ChatResponseFormat } from './providers/types.js';
import { runTurnEvents, usageForLog } from './run-turn-core.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { ChatToolset } from './tools/mcp-adapter.js';
import { applyTurnContext } from './turn-context.js';
import { type ImageResolver, resolveVisionImages, type TurnImage } from './vision.js';

export interface ExternalChatTurnArgs {
  projectId: string;
  adapter: ConversationAdapter;
  message: string;
  /** The Forge user this turn runs as. A turn that names a room REQUIRES one; an ephemeral turn, which names none, does not. */
  userId?: string | null;
  /** Continue this conversation. */
  conversationId?: string | undefined;
  /** Or open/resume the venue it happens in, in the transport's own terms. */
  externalId?: string | undefined;
  shape?: ConversationShape | undefined;
  /** Read-only toolset (caller builds it with the right principal); omit for tool-less. */
  tools?: ChatToolset | undefined;
  /** `chat_logs.user_key` audit key (e.g. the external user id). */
  userKey?: string | null;
  /**
   * The Forge user the newest person message is LINKED to — whose preferences
   * this reply honours and whose writes the speaker-bound tools make. Distinct
   * from `userId`, which is who the turn ACTS as (ISS-1034).
   */
  // cm:guard three values, three meanings: absent means "the principal spoke" (every caller that predates the split, and every direct venue); a string names a linked speaker who is not the principal (a group venue); `null` means the newest author is nobody Forge knows, which the turn is TOLD rather than left to guess (codex F1).
  speakerUserId?: string | null | undefined;
  /** The transport's own label for the speaker, quoted in the unlinked sentence and nowhere else. */
  speakerLabel?: string | null | undefined;
  /** Channel persona for the system prompt (ISS-609); override still wins. */
  persona?: string | null;
  /** Seeded recent-conversation block for the system prompt (ISS-609). */
  conversationContext?: string | null;
  /** Images that arrived WITH this message, bytes in hand; stored by reference, sent as content parts. */
  images?: readonly TurnImage[] | undefined;
  /** Re-fetch bytes for an image from an EARLIER turn inside the vision lookback; omit to let older images fall out of view. */
  resolveImage?: ImageResolver | undefined;
  /** Aborts the turn (provider fetch + SSE read) so a hung upstream terminates as an error instead of wedging the caller. */
  signal?: AbortSignal | undefined;
  responseFormat?: ChatResponseFormat | undefined;
  /** Picks `app_config.chat_model_by_kind[kind]`; defaults to `'agentic'`. */
  turnKind?: ChatTurnKind | undefined;
  /**
   * What this turn WRITES to the room it reads. Default: the question and the answer.
   */
  // cm:guard a SCREENED adapter passes `question-only` and records the answer itself: the model's first answer can fail the reply guard and be replaced by a corrective retry or a fixed fallback, and a transcript holding the rejected text is a record of a conversation nobody had (ISS-1001).
  // cm:guard `nothing` is for the RETRY of such a turn — its message is a code-authored instruction, and persisting it files words the speaker never said under their name — while a SILENCE is written under `question-only` all the same, because nothing replaces it and the reason is the row's whole point.
  // cm:guard `silence-only` is for a turn whose question is ALREADY a row — the collector wrote it when the message arrived — and whose answer is the screened caller's to record after delivery. What it still owes the transcript is the SILENCE: without it a window the model declined to answer leaves no row, and a person cannot tell it from a turn that never ran (ISS-1004).
  record?: 'question-and-answer' | 'question-only' | 'silence-only' | 'nothing';
  db?: typeof defaultDb;
}

export interface ExternalChatTurnResult {
  /** The conversation this turn joined, or null when it belonged to none. */
  conversationId: string | null;
  /** The row this turn's answer became, for the caller to stamp with its delivery receipt. */
  assistantMessageId: string | null;
  reply: string;
  terminal: 'done' | 'error';
  error: string | null;
  iterations: number;
  /** Tool calls the model made this turn — callers verify reply claims (cited issue ids) against what was actually done. */
  toolCalls: Array<{ name: string; arguments: string }>;
  /** The progress snapshot injected into THIS turn's system prompt (ISS-671), or `null` on a computation failure; callers screen the reply against it rather than re-querying, so the guard never bounces a reply that matched what the model was shown. */
  progress: ProjectProgress | null;
}

export async function runExternalChatTurn(
  args: ExternalChatTurnArgs,
): Promise<ExternalChatTurnResult> {
  const dbi = args.db ?? defaultDb;

  const [project] = await dbi
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      agentConfig: projects.agentConfig,
    })
    .from(projects)
    .where(eq(projects.id, args.projectId))
    .limit(1);
  if (!project) throw new Error(`project not found: ${args.projectId}`);

  const [appCfg] = await dbi
    .select({ systemPromptOverride: appConfig.systemPromptOverride })
    .from(appConfig)
    .where(eq(appConfig.projectId, args.projectId))
    .limit(1);

  // cm:why computed unconditionally every turn, never gated on "is this a progress question" — that intent-routing is the hole ISS-673 fell through
  const progress = await computeProjectProgress(args.projectId, dbi);

  const resolved = await resolveForProject(args.projectId, {
    fallbackProviderId: defaultChatProviderId(),
    kind: args.turnKind,
    db: dbi,
  });

  // cm:guard a turn with neither a conversation nor a venue is EPHEMERAL and writes no room: the escalation bridge's synthesis is one message posted by another path, not a conversation being had, and giving it a room of its own left an unread `chat_sessions` row behind every escalation (ISS-1001).
  const turn: ConversationTurn | null =
    args.conversationId || args.externalId
      ? await openTurn({
          projectId: args.projectId,
          adapter: args.adapter,
          conversationId: args.conversationId,
          externalId: args.externalId,
          shape: args.shape ?? 'direct',
          readerUserId: args.userId ?? null,
          db: dbi,
        })
      : null;

  const record = args.record ?? 'question-and-answer';
  const images = args.images ?? [];
  // cm:guard `silence-only` appends NOTHING here, and that is not the same as `nothing`: the retry's instruction is appended-but-unpersisted so the model sees it, while a collected question is already IN `turn.history`, so appending it again would show the model the same message twice.
  if (turn && record !== 'silence-only') {
    appendUserMessage(turn, args.message, {
      images,
      authorUserId: args.userId ?? null,
      authorLabel: args.userKey ?? null,
    });
  }

  // cm:guard the self is read off the HANDLE the turn speaks as (`turn.handleUserId`, the participant row carrying this project) and never off "the project's agent": a project may hold more than one agent account and the room names which one is in it (ISS-1034 criterion 3).
  const selves = turn?.handleUserId ? await readSelvesFor([turn.handleUserId], dbi) : new Map();
  const self = turn?.handleUserId ? (selves.get(turn.handleUserId) ?? null) : null;
  const speakerUserId =
    args.speakerUserId === undefined ? (args.userId ?? null) : args.speakerUserId;
  const speakerContext = speakerSection({
    speakerUserId,
    speakerLabel: args.speakerLabel ?? args.userKey ?? null,
    preferences: speakerUserId ? await readAssistantPreferences(speakerUserId, dbi) : null,
  });

  const systemPrompt = buildSystemPrompt({
    project: { name: project.name, agentConfig: project.agentConfig },
    self,
    appConfig: appCfg ?? null,
    persona: args.persona ?? null,
    progressFacts: progress ? buildProgressFactsBlock(progress) : null,
  });
  const historyWindow = turn
    ? [...turn.history, ...turn.pending]
        .slice(-PROVIDER_HISTORY_WINDOW)
        .map((m) => ({ role: m.role, content: m.content, images: m.images }))
    : [];
  const resolvedImages = await resolveVisionImages(historyWindow, images, args.resolveImage);
  const providerMessages = applyTurnContext(
    [
      { role: 'system' as const, content: systemPrompt },
      ...(turn
        ? toProviderMessages(turn, resolvedImages).slice(-PROVIDER_HISTORY_WINDOW)
        : [{ role: 'user' as const, content: args.message }]),
    ],
    { conversationContext: args.conversationContext, speakerContext },
  );

  const startedAt = Date.now();
  const gen = runTurnEvents({
    provider: resolved.provider,
    model: resolved.model,
    messages: providerMessages,
    tools: args.tools,
    // cm:why an adapter turn is an agentic worker, not creative chat: a low temperature keeps small models on the call-the-tool path instead of narrating what they are "about to" do.
    temperature: 0.2,
    requireInitialToolUse: args.tools !== undefined,
    contextBudgetTokens: env.CHAT_CONTEXT_BUDGET_TOKENS,
    reasoningEffort: env.CHAT_REASONING_EFFORT,
    responseFormat: args.responseFormat,
    signal: args.signal,
  });
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  const result = step.value;
  const durationMs = Date.now() - startedAt;
  if (result.elided.overBudget) {
    logger.warn(
      { conversationId: turn?.conversationId ?? null, elided: result.elided },
      'chat: request exceeds the context budget even after elision',
    );
  }

  // cm:guard LOG-ONLY and after the reply is built, never before: the probe's false-positive rate is unmeasured, and a detector that silences an answer on its first day cannot be told from one that silences correct answers. `chat_logs` writes `reply` beside `tool_calls` a few lines below, so what this warn opens is the window that decides whether a refusal is earned (ISS-1008).
  const confab = detectStateConfab(result.finalText, result.toolCalls);
  if (confab.suspected) {
    logger.warn(
      { conversationId: turn?.conversationId ?? null, claims: confab.claims },
      "chat: the reply claims a write this turn's own tool result refused",
    );
  }

  let assistantMessageId: string | null = null;
  if (turn && record !== 'nothing') {
    if (result.terminal === 'done' && result.finalText.length > 0) {
      if (record === 'question-and-answer') appendAssistantMessage(turn, result.finalText);
    } else {
      appendSilence(
        turn,
        result.errorMessage ?? (result.terminal === 'done' ? 'empty-reply' : result.terminal),
      );
    }
    const written = await persistMessages(turn, { db: dbi });
    assistantMessageId =
      written.find((m) => m.role === 'assistant' && !m.silenceReason)?.id ?? null;
  }

  try {
    await dbi.insert(chatLogs).values({
      sessionId: turn?.conversationId ?? null,
      projectSlug: project.slug,
      userKey: args.userKey ?? args.userId ?? null,
      query: args.message,
      reply: result.finalText.length > 0 ? result.finalText : null,
      model: resolved.model,
      toolCalls: result.toolCalls as never,
      usage: usageForLog(result) as never,
      iterations: result.iterations,
      durationMs,
      error: result.errorMessage,
      source: args.adapter,
    });
  } catch (err) {
    logger.error({ err, conversationId: turn?.conversationId ?? null }, 'chat_logs insert failed');
  }

  return {
    conversationId: turn?.conversationId ?? null,
    assistantMessageId,
    reply: result.finalText,
    terminal: result.terminal,
    error: result.errorMessage,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    progress,
  };
}
