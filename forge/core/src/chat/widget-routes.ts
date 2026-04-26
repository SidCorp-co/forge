/**
 * v1 EPIC 1 PR-C (ISS-295) — Widget chat endpoint.
 *
 * Mirrors `chatRoutes` (PR-B) but authenticates via `X-Forge-API-Key`
 * instead of the user cookie. The project is resolved from the key by the
 * `requireProjectApiKey()` middleware; widget callers do not pass `projectId`
 * because the key already pins it. `chat_logs.source` is `'widget'`.
 *
 * Gated by feature flag `chatProvider`.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { db } from '../db/client.js';
import { appConfig, chatLogs, projects } from '../db/schema.js';
import { type ApiKeyVars, requireProjectApiKey } from '../middleware/api-key.js';
import { defaultChatProviderId } from './providers/bootstrap.js';
import { resolveForProject } from './providers/registry.js';
import type { ChatStreamEvent, ChatStreamUsage } from './providers/types.js';
import {
  appendAssistantMessage,
  appendUserMessage,
  loadOrCreateSession,
  persistMessages,
  toProviderMessages,
} from './session.js';
import { buildSystemPrompt } from './system-prompt.js';

const widgetChatRequestSchema = z
  .object({
    message: z.string().min(1).max(40_000),
    sessionId: z.uuid().optional(),
    pageContext: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const widgetChatRoutes = new Hono<{ Variables: ApiKeyVars }>();
widgetChatRoutes.use('*', requireProjectApiKey());

widgetChatRoutes.post(
  '/',
  zValidator('json', widgetChatRequestSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { message, sessionId, pageContext } = c.req.valid('json');
    const projectStub = c.get('project');
    const projectId = projectStub.id;

    const [project] = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        agentConfig: projects.agentConfig,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw notFound('project not found');

    const [appCfg] = await db
      .select({ systemPromptOverride: appConfig.systemPromptOverride })
      .from(appConfig)
      .where(eq(appConfig.projectId, projectId))
      .limit(1);

    const resolved = await resolveForProject(projectId, {
      fallbackProviderId: defaultChatProviderId(),
    });

    const session = await loadOrCreateSession({
      projectId,
      sessionId,
      userId: null,
      source: 'widget',
    });

    appendUserMessage(session, message);

    const systemPrompt = buildSystemPrompt({
      project,
      appConfig: appCfg ?? null,
      pageContext: pageContext ?? null,
    });
    const providerMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...toProviderMessages(session),
    ];

    return streamSSE(c, async (stream) => {
      c.header('X-Accel-Buffering', 'no');
      await stream.writeSSE({
        event: 'session',
        data: JSON.stringify({ sessionId: session.id }),
      });

      const ac = new AbortController();
      stream.onAbort(() => ac.abort());

      const startedAt = Date.now();
      let assistantText = '';
      let usage: ChatStreamUsage | null = null;
      let errorMessage: string | null = null;
      let terminal: 'done' | 'error' | null = null;

      try {
        for await (const event of resolved.provider.stream({
          model: resolved.model,
          messages: providerMessages,
          signal: ac.signal,
        })) {
          if (event.type === 'chunk') {
            assistantText += event.text;
          } else if (event.type === 'usage') {
            usage = event.usage;
          } else if (event.type === 'error') {
            errorMessage = event.message;
            terminal = 'error';
          } else if (event.type === 'done') {
            terminal = 'done';
          }
          await writeEvent(stream, event);
          if (event.type === 'done' || event.type === 'error') break;
        }
        if (terminal === null) {
          terminal = 'done';
          await writeEvent(stream, { type: 'done' });
        }
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        terminal = 'error';
        await writeEvent(stream, { type: 'error', message: errorMessage });
      }

      const durationMs = Date.now() - startedAt;

      if (terminal === 'done' && assistantText.length > 0) {
        appendAssistantMessage(session, assistantText);
        await persistMessages(session);
      } else {
        await persistMessages(session);
      }

      try {
        await db.insert(chatLogs).values({
          sessionId: session.id,
          projectSlug: project.slug,
          userKey: null,
          query: message,
          reply: assistantText.length > 0 ? assistantText : null,
          model: resolved.model,
          ragContext: null,
          toolCalls: [] as never,
          usage: (usage as never) ?? null,
          iterations: 1,
          durationMs,
          error: errorMessage,
          queryIntent: null,
          source: session.source,
        });
      } catch (err) {
        console.error('chat_logs insert failed (widget)', err);
      }
    });
  },
);

async function writeEvent(
  stream: { writeSSE: (msg: { event: string; data: string }) => Promise<void> },
  event: ChatStreamEvent,
): Promise<void> {
  const { type, ...rest } = event;
  await stream.writeSSE({ event: type, data: JSON.stringify(rest) });
}
