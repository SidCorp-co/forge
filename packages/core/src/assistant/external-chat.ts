/**
 * One assistant-mode chat turn drained to a reply string: the project's prompt, the room's window,
 * the model through the shared turn loop. The caller supplies the toolset (it owns the principal);
 * none means a tool-less completion. A turn belongs to a conversation named by its id, or to none,
 * which is what a one-shot relay is.
 */

import { contentLanguageBlock } from '@forge/contracts/content-language';
import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import type { ConversationAdapter } from '../db/schema-conversations.js';
import {
  type ChatMessage,
  type ChatStreamEvent,
  defaultChatProviderId,
  resolveChatProvider,
} from '../integrations/llm/index.js';
import {
  buildProgressFactsBlock,
  computeProjectProgress,
  type ProjectProgress,
} from '../issues/index.js';
import { dataPolicyOf, EgressRefused, egressAt, egressText } from '../lib/data-egress.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { readContentLanguage } from '../project-config/index.js';
import { detectStateConfab } from './confab.js';
import { PROVIDER_HISTORY_WINDOW } from './context-budget.js';
import { STOPPED_BY_A_PERSON } from './conversation-stops.js';
import {
  appendSilence,
  appendUserMessage,
  type ConversationTurn,
  openTurn,
  persistMessages,
  toProviderMessages,
} from './conversation-turn.js';
import { runTurnEvents } from './run-turn-core.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { ChatToolset } from './tools/mcp-adapter.js';
import { memoryNoteGateFor } from './tools/memory-note-gate-deps.js';
import { applyTurnContext } from './turn-context.js';
import { loadTurnSelf } from './turn-self.js';
import { type ImageResolver, resolveVisionImages, type TurnImage } from './vision.js';

export interface ExternalChatTurnArgs {
  projectId: string;
  adapter: ConversationAdapter;
  message: string;
  /** The Forge user this turn runs as. A turn that names a room REQUIRES one; an ephemeral turn, which names none, does not. */
  userId?: string | null;
  /** Continue this conversation. */
  conversationId?: string | undefined;
  /** Read-only toolset (caller builds it with the right principal); omit for tool-less. */
  tools?: ChatToolset | undefined;
  /** The external speaker's key (e.g. the external user id), the author label when no speaker label is given. */
  userKey?: string | null;
  /**
   * The Forge user the newest person message is LINKED to — whose preferences
   * this reply honours and whose writes the speaker-bound tools make. Distinct
   * from `userId`, which is who the turn ACTS as (ISS-1034).
   */
  speakerUserId?: string | null | undefined;
  /** The transport's own label for the speaker, quoted in the unlinked sentence and nowhere else. */
  speakerLabel?: string | null | undefined;
  /** Channel persona for the system prompt (ISS-609); override still wins. */
  persona?: string | null;
  /** Seeded recent-conversation block for the system prompt (ISS-609). */
  conversationContext?: string | null;
  pageContext?: Record<string, unknown> | null;
  /** Images that arrived WITH this message, bytes in hand; stored by reference, sent as content parts. */
  images?: readonly TurnImage[] | undefined;
  /** Re-fetch bytes for an image from an EARLIER turn inside the vision lookback; omit to let older images fall out of view. */
  resolveImage?: ImageResolver | undefined;
  /** Aborts the turn (provider fetch + SSE read) so a hung upstream terminates as an error instead of wedging the caller. */
  signal?: AbortSignal | undefined;
  /**
   * Called for each event the turn loop yields, as it yields it.
   */
  onTurnEvent?: ((event: ChatStreamEvent) => void) | undefined;
  /** What this turn WRITES to the room it reads; the screened answer is recorded by its deliverer. Default: nothing. */
  record?: 'question-only' | 'silence-only' | 'nothing';
  /**
   * The question is already a row of this conversation, so it is not appended again.
   */
  questionInHistory?: boolean;
}

export interface ExternalChatTurnResult {
  /** The conversation this turn joined, or null when it belonged to none. */
  conversationId: string | null;
  reply: string;
  terminal: 'done' | 'error';
  error: string | null;
  iterations: number;
  /** Tool calls the model made this turn — callers verify reply claims (cited issue ids) against what was actually done. */
  toolCalls: Array<{
    name: string;
    arguments: string;
    isError?: boolean;
    refusalCode?: string | null;
  }>;
  /** The progress snapshot injected into THIS turn's system prompt (ISS-671), or `null` on a computation failure; callers screen the reply against it rather than re-querying, so the guard never bounces a reply that matched what the model was shown. */
  progress: ProjectProgress | null;
}

// cm:guard everything a chat turn's model reads is the conversation (surface `conversation`), the
// tool results it calls for included: each text block leaves through the one egress rule, so a
// tool that reads the room or the project hands it nothing the level forbids
function egressedTools(level: SensitiveDataLevel, tools: ChatToolset, what: string): ChatToolset {
  if (level === 'off') return tools;
  return {
    ...tools,
    async execute(name, argsJson) {
      const result = await tools.execute(name, argsJson);
      return {
        ...result,
        content: result.content.map((block) => {
          if (block.type !== 'text') return block;
          const out = egressText(level, 'conversation', block.text, `${what}, tool ${name}`);
          if (!out.ok) throw new EgressRefused(out.refusal);
          return { ...block, text: out.text };
        }),
      };
    },
  };
}

interface TurnSetup {
  turn: ConversationTurn | null;
  messages: ChatMessage[];
  progress: ProjectProgress | null;
  what: string;
}

/** The prompt, the room's window and this message, egressed for the model. */
async function setUpTurn(
  args: ExternalChatTurnArgs,
): Promise<TurnSetup & { level: SensitiveDataLevel }> {
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, args.projectId))
    .limit(1);
  if (!project) throw new Error(`project not found: ${args.projectId}`);
  const progress = await computeProjectProgress(args.projectId, db);
  const language = await readContentLanguage(args.projectId);

  const turn = args.conversationId
    ? await openTurn({
        projectId: args.projectId,
        adapter: args.adapter,
        conversationId: args.conversationId,
        readerUserId: args.userId ?? null,
      })
    : null;
  const images = args.images ?? [];
  if (turn && !args.questionInHistory) {
    appendUserMessage(turn, args.message, {
      images,
      authorUserId: args.userId ?? null,
      authorLabel: args.userKey ?? null,
    });
  }

  const { self, speakerContext } = await loadTurnSelf({
    handleUserId: turn?.handleUserId ?? null,
    speakerUserId: args.speakerUserId === undefined ? (args.userId ?? null) : args.speakerUserId,
    speakerLabel: args.speakerLabel ?? args.userKey ?? null,
    db,
  });
  const systemPrompt = buildSystemPrompt({
    project: { name: project.name },
    self,
    persona: args.persona ?? null,
    progressFacts: progress ? buildProgressFactsBlock(progress) : null,
    contentLanguage: contentLanguageBlock(language, 'chat'),
  });
  const history = turn ? [...turn.history, ...turn.pending].slice(-PROVIDER_HISTORY_WINDOW) : [];
  const resolvedImages = await resolveVisionImages(history, images, args.resolveImage);
  const [system, ...spoken] = applyTurnContext(
    [
      { role: 'system' as const, content: systemPrompt },
      ...(turn
        ? toProviderMessages(turn, resolvedImages).slice(-PROVIDER_HISTORY_WINDOW)
        : [{ role: 'user' as const, content: args.message }]),
    ],
    {
      conversationContext: args.conversationContext,
      pageContext: args.pageContext ?? null,
      speakerContext,
    },
  );
  const level = await dataPolicyOf(args.projectId);
  const what = `conversation ${turn?.conversationId ?? 'turn'}`;
  const sent = egressAt(level, 'conversation', spoken, what);
  if (!sent.ok) throw new EgressRefused(sent.refusal);
  return { turn, messages: system ? [system, ...sent.value] : sent.value, progress, what, level };
}

export async function runExternalChatTurn(
  args: ExternalChatTurnArgs,
): Promise<ExternalChatTurnResult> {
  const { turn, messages, progress, what, level } = await setUpTurn(args);
  const resolved = resolveChatProvider(defaultChatProviderId());
  const gen = runTurnEvents({
    provider: resolved.provider,
    model: resolved.model,
    messages,
    tools: args.tools && egressedTools(level, args.tools, what),
    preCall: memoryNoteGateFor(args.projectId),
    temperature: 0.2,
    requireInitialToolUse: args.tools !== undefined,
    contextBudgetTokens: env.CHAT_CONTEXT_BUDGET_TOKENS,
    reasoningEffort: env.CHAT_REASONING_EFFORT,
    signal: args.signal,
  });
  let step = await gen.next();
  while (!step.done) {
    try {
      args.onTurnEvent?.(step.value);
    } catch (err) {
      await gen.return(undefined as never).catch(() => undefined);
      throw err;
    }
    step = await gen.next();
  }
  const result = step.value;
  const conversationId = turn?.conversationId ?? null;
  if (result.elided.overBudget) {
    logger.warn(
      { conversationId, elided: result.elided },
      'chat: request exceeds the context budget even after elision',
    );
  }
  const confab = detectStateConfab(result.finalText, result.toolCalls);
  if (confab.suspected) {
    logger.warn(
      { conversationId, claims: confab.claims },
      "chat: the reply claims a write this turn's own tool result refused",
    );
  }

  if (turn && (args.record ?? 'nothing') !== 'nothing') {
    // A person who stopped this turn gets no silence row: "nothing to add" is not "you ended this",
    // and a provider that answers a cancelled call with an error result would write the first (ISS-1146).
    const stoppedByAPerson = args.signal?.aborted && args.signal.reason === STOPPED_BY_A_PERSON;
    const answered = result.terminal === 'done' && result.finalText.length > 0;
    if (!answered && !stoppedByAPerson) {
      appendSilence(
        turn,
        result.errorMessage ?? (result.terminal === 'done' ? 'empty-reply' : result.terminal),
      );
    }
    await persistMessages(turn);
  }

  return {
    conversationId,
    reply: result.finalText,
    terminal: result.terminal,
    error: result.errorMessage,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    progress,
  };
}
