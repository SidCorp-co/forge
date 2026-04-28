/**
 * v1 EPIC 1 PR-C (ISS-295) — Widget chat endpoint.
 *
 * Mirrors `chatRoutes` (PR-B) but authenticates via `X-Forge-API-Key`
 * (`requireProjectApiKey()`); the project is resolved from the key so
 * widget callers do not pass `projectId`. `chat_logs.source` and
 * `chat_sessions.source` are `'widget'`. Streaming + `chat_logs` insert
 * live in `./run-turn.ts` (shared with `chatRoutes`).
 *
 * Gated by feature flag `chatProvider`.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { appConfig, projects } from '../db/schema.js';
import { type ApiKeyVars, requireProjectApiKey } from '../middleware/api-key.js';
import { defaultChatProviderId } from './providers/bootstrap.js';
import { resolveForProject } from './providers/registry.js';
import { runChatTurn } from './run-turn.js';
import { appendUserMessage, loadOrCreateSession, toProviderMessages } from './session.js';
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

    // The middleware already gave us id/slug/name; only `agentConfig` is
    // missing for `buildSystemPrompt`. One narrow round-trip beats re-
    // selecting the whole row.
    const [agentRow] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

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
      project: {
        name: projectStub.name,
        agentConfig: agentRow?.agentConfig ?? null,
      },
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
      projectSlug: projectStub.slug,
      userMessage: message,
      userKey: null,
    });
  },
);
