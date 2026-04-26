/**
 * v1 EPIC 1 (ISS-270) — `POST /api/chat` SSE skeleton.
 *
 * PR-A scope: resolve provider for the project, stream chunks back, no
 * persistence yet. Session loading + chat_logs writes land in PR-B; widget
 * + API-key auth land in PR-C. The whole route is gated by feature flag
 * `chatProvider`; when off, the route is not mounted (404).
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { defaultChatProviderId } from './providers/bootstrap.js';
import { resolveForProject } from './providers/registry.js';
import type { ChatStreamEvent } from './providers/types.js';

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

export const chatRoutes = new Hono<{ Variables: AuthVars }>();
chatRoutes.use('*', requireAuth(), assertEmailVerified());

chatRoutes.post(
  '/',
  zValidator('json', chatRequestSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, message, pageContext } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const resolved = await resolveForProject(projectId, {
      fallbackProviderId: defaultChatProviderId(),
    });

    // PR-A is stateless: no session lookup, no system-prompt builder. Pass
    // the user message through with optional pageContext as a single user
    // turn so providers can be smoke-tested end-to-end. PR-B replaces this
    // with the session-aware message construction.
    const messages = pageContext
      ? [
          {
            role: 'user' as const,
            content: `Context:\n${JSON.stringify(pageContext, null, 2)}\n\nMessage:\n${message}`,
          },
        ]
      : [{ role: 'user' as const, content: message }];

    return streamSSE(c, async (stream) => {
      // Disable buffering on Traefik / nginx so events flush immediately.
      c.header('X-Accel-Buffering', 'no');

      const ac = new AbortController();
      stream.onAbort(() => ac.abort());

      try {
        for await (const event of resolved.provider.stream({
          model: resolved.model,
          messages,
          signal: ac.signal,
        })) {
          await writeEvent(stream, event);
          if (event.type === 'done' || event.type === 'error') return;
        }
        await writeEvent(stream, { type: 'done' });
      } catch (err) {
        await writeEvent(stream, {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
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
