/**
 * ISS-604 (P2a) — non-streaming chat entrypoint for external channels (Rocket.Chat, Telegram, …):
 * the same resolution as the SSE `/api/chat` route, but the shared turn loop is drained to one
 * reply string. The caller supplies the toolset (it owns the principal); none means a tool-less
 * completion. Persists the final assistant text and a `chat_logs` audit row exactly like the SSE path.
 */

import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db as defaultDb } from '../db/client.js';
import { appConfig, chatLogs, projects } from '../db/schema.js';
import {
  buildProgressFactsBlock,
  computeProjectProgress,
  type ProjectProgress,
} from '../issues/progress.js';
import { logger } from '../logger.js';
import { PROVIDER_HISTORY_WINDOW } from './context-budget.js';
import { defaultChatProviderId } from './providers/bootstrap.js';
import { type ChatTurnKind, resolveForProject } from './providers/registry.js';
import type { ChatResponseFormat } from './providers/types.js';
import { runTurnEvents, usageForLog } from './run-turn-core.js';
import {
  appendAssistantMessage,
  appendUserMessage,
  type ChatSessionSource,
  loadOrCreateSession,
  persistMessages,
  toProviderMessages,
} from './session.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { ChatToolset } from './tools/mcp-adapter.js';
import { applyTurnContext } from './turn-context.js';
import { type ImageResolver, resolveVisionImages, type TurnImage } from './vision.js';

export interface ExternalChatTurnArgs {
  projectId: string;
  source: ChatSessionSource;
  message: string;
  /** Forge user who owns the session, or null for an anonymous external user. */
  userId?: string | null;
  /** Continue an existing conversation; omit to start a new one. */
  sessionId?: string | undefined;
  /** Read-only toolset (caller builds it with the right principal); omit for tool-less. */
  tools?: ChatToolset | undefined;
  /** `chat_logs.user_key` audit key (e.g. the external user id). */
  userKey?: string | null;
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
  db?: typeof defaultDb;
}

/** External sessions live as long as the room (never rotated), so the persisted transcript is bounded too — the model-visible window is `context-budget.ts`'s. */
const PERSISTED_MESSAGES_CAP = 200;

export interface ExternalChatTurnResult {
  sessionId: string;
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
    kind: args.turnKind ?? 'agentic',
    db: dbi,
  });

  const session = await loadOrCreateSession({
    projectId: args.projectId,
    sessionId: args.sessionId,
    userId: args.userId ?? null,
    source: args.source,
    db: dbi,
  });

  const images = args.images ?? [];
  appendUserMessage(session, args.message, images);

  const systemPrompt = buildSystemPrompt({
    project: { name: project.name, agentConfig: project.agentConfig },
    appConfig: appCfg ?? null,
    persona: args.persona ?? null,
    progressFacts: progress ? buildProgressFactsBlock(progress) : null,
  });
  const historyWindow = session.messages.slice(-PROVIDER_HISTORY_WINDOW);
  const resolvedImages = await resolveVisionImages(historyWindow, images, args.resolveImage);
  const providerMessages = applyTurnContext(
    [
      { role: 'system' as const, content: systemPrompt },
      ...toProviderMessages(session, resolvedImages).slice(-PROVIDER_HISTORY_WINDOW),
    ],
    { conversationContext: args.conversationContext },
  );

  const startedAt = Date.now();
  const gen = runTurnEvents({
    provider: resolved.provider,
    model: resolved.model,
    messages: providerMessages,
    tools: args.tools,
    // External-channel turns are agentic workers, not creative chat — a low
    // temperature keeps small models on the call-the-tool path instead of
    // narrating what they are "about to" do, and the first round REQUIRES a
    // tool call so a lazy model cannot answer (or invent an action) without
    // having investigated anything.
    temperature: 0.2,
    requireInitialToolUse: args.tools !== undefined,
    contextBudgetTokens: env.CHAT_CONTEXT_BUDGET_TOKENS,
    responseFormat: args.responseFormat,
    signal: args.signal,
  });
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  const result = step.value;
  const durationMs = Date.now() - startedAt;
  if (result.elided.overBudget) {
    logger.warn(
      { sessionId: session.id, elided: result.elided },
      'chat: request exceeds the context budget even after elision',
    );
  }

  if (result.terminal === 'done' && result.finalText.length > 0) {
    appendAssistantMessage(session, result.finalText);
  }
  if (session.messages.length > PERSISTED_MESSAGES_CAP) {
    session.messages = session.messages.slice(-PERSISTED_MESSAGES_CAP);
  }
  await persistMessages(session, { db: dbi });

  try {
    await dbi.insert(chatLogs).values({
      sessionId: session.id,
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
      source: session.source,
    });
  } catch (err) {
    logger.error({ err, sessionId: session.id }, 'chat_logs insert failed');
  }

  return {
    sessionId: session.id,
    reply: result.finalText,
    terminal: result.terminal,
    error: result.errorMessage,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    progress,
  };
}
