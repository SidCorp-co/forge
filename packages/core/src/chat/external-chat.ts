/**
 * ISS-604 (P2a) — non-streaming chat entrypoint for external channels
 * (Rocket.Chat, Telegram, …). Mirrors the resolution the SSE `/api/chat` route
 * does, but drains the shared turn loop ({@link runTurnEvents}) to a single
 * reply string — the shape an external bot needs (one complete message, not an
 * SSE stream).
 *
 * The caller supplies the toolset (so it owns the principal/scope); pass none
 * for a plain, tool-less completion. Persists the final assistant text to the
 * session + a `chat_logs` audit row, exactly like the SSE path.
 */

import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { appConfig, chatLogs, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { defaultChatProviderId } from './providers/bootstrap.js';
import { resolveForProject } from './providers/registry.js';
import { runTurnEvents } from './run-turn-core.js';
import {
  type ChatSessionSource,
  appendAssistantMessage,
  appendUserMessage,
  loadOrCreateSession,
  persistMessages,
  toProviderMessages,
} from './session.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

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
  db?: typeof defaultDb;
}

/**
 * External sessions live as long as the room (one per RC room, never rotated),
 * so both the model-visible window and the persisted transcript must be
 * bounded or a chatty room grows the prompt until every turn fails on context.
 */
const PROVIDER_HISTORY_WINDOW = 30;
const PERSISTED_MESSAGES_CAP = 200;

export interface ExternalChatTurnResult {
  sessionId: string;
  reply: string;
  terminal: 'done' | 'error';
  error: string | null;
  iterations: number;
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

  const resolved = await resolveForProject(args.projectId, {
    fallbackProviderId: defaultChatProviderId(),
    db: dbi,
  });

  const session = await loadOrCreateSession({
    projectId: args.projectId,
    sessionId: args.sessionId,
    userId: args.userId ?? null,
    source: args.source,
    db: dbi,
  });

  appendUserMessage(session, args.message);

  const systemPrompt = buildSystemPrompt({
    project: { name: project.name, agentConfig: project.agentConfig },
    appConfig: appCfg ?? null,
    pageContext: null,
    persona: args.persona ?? null,
    conversationContext: args.conversationContext ?? null,
  });
  const providerMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...toProviderMessages(session).slice(-PROVIDER_HISTORY_WINDOW),
  ];

  const startedAt = Date.now();
  const gen = runTurnEvents({
    provider: resolved.provider,
    model: resolved.model,
    messages: providerMessages,
    tools: args.tools,
    // External-channel turns are agentic workers, not creative chat — a low
    // temperature keeps small models on the call-the-tool path instead of
    // narrating what they are "about to" do.
    temperature: 0.2,
  });
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  const result = step.value;
  const durationMs = Date.now() - startedAt;

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
      ragContext: null,
      toolCalls: result.toolCalls as never,
      usage: (Object.keys(result.usage).length > 0 ? result.usage : null) as never,
      iterations: result.iterations,
      durationMs,
      error: result.errorMessage,
      queryIntent: null,
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
  };
}
