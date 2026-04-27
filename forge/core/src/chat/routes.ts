/**
 * v1 EPIC 1 (ISS-270 / PR-B) — `POST /api/chat` SSE with session persistence
 * + chat_logs audit.
 *
 * PR-A added the SSE skeleton and provider registry. PR-B (this file) loads
 * or creates a `chat_sessions` row keyed by `sessionId`, builds the v1
 * minimal system prompt from project + `app_config.systemPromptOverride` +
 * optional `pageContext`, streams the assistant reply, then on `done`
 * appends the assistant message + writes one `chat_logs` row + broadcasts
 * `chat.message` on the user's WS room. On `error` the failure is recorded
 * in `chat_logs.error` and re-emitted on the SSE stream.
 *
 * Widget / API-key auth is PR-C — for now `source` is hard-coded to `'web'`.
 * The whole route is gated by feature flag `chatProvider`.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { db } from '../db/client.js';
import { appConfig, chatLogs, projects } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { userRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
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

const chatRequestSchema = z
  .object({
    projectId: z.uuid(),
    message: z.string().min(1).max(40_000),
    sessionId: z.uuid().optional(),
    pageContext: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const chatRoutes = new Hono<{ Variables: AuthVars }>();
chatRoutes.use('*', requireAuth(), assertEmailVerified());

chatRoutes.post(
  '/',
  zValidator('json', chatRequestSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, message, sessionId, pageContext } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

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
      userId,
      source: 'web',
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
      // Disable buffering on Traefik / nginx so events flush immediately.
      c.header('X-Accel-Buffering', 'no');
      // Echo back the resolved sessionId so the client can stash it for the
      // next turn without parsing a separate REST response.
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
        roomManager.publish(userRoom(userId), {
          event: 'chat.message',
          data: {
            sessionId: session.id,
            projectId: session.projectId,
            role: 'assistant',
          },
        });
      } else {
        // Persist the user message even on error so the UI can surface the
        // partial turn and the user's prior context isn't lost.
        await persistMessages(session);
      }

      try {
        await db.insert(chatLogs).values({
          sessionId: session.id,
          projectSlug: project.slug,
          userKey: userId,
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
        // chat_logs is best-effort audit — don't fail the request when the
        // INSERT errors (e.g. db pool exhausted). The SSE stream has already
        // delivered to the client; logging the failure is enough.
        console.error('chat_logs insert failed', err);
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
