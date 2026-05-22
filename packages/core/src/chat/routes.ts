/**
 * v1 EPIC 1 (ISS-270 / PR-B) — `POST /api/chat` SSE with session persistence
 * + chat_logs audit. Cookie / Bearer authenticated.
 *
 * The shared streaming + persistence logic lives in `./run-turn.ts`; this
 * file owns auth, project membership lookup, and session source tagging.
 *
 * The whole route is gated by feature flag `chatProvider`.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { appConfig, projects } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { defaultChatProviderId } from './providers/bootstrap.js';
import { resolveForProject } from './providers/registry.js';
import { runChatTurn } from './run-turn.js';
import { appendUserMessage, loadOrCreateSession, toProviderMessages } from './session.js';
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

    return runChatTurn({
      c,
      session,
      resolved,
      providerMessages,
      projectSlug: project.slug,
      userMessage: message,
      userKey: userId,
    });
  },
);
