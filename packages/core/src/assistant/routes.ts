/**
 * v1 EPIC 1 (ISS-270 / PR-B) — `POST /api/chat` SSE over a durable conversation
 * + chat_logs audit. Cookie / Bearer authenticated.
 *
 * The shared streaming + persistence logic lives in `./run-turn.ts`; this file
 * owns auth, project membership lookup, and opening the web venue.
 *
 * The whole route is gated by feature flag `chatProvider`.
 */

import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { readAssistantPreferences } from '../auth/preference-changes.js';
import { env } from '../config/env.js';
import { addPerson } from '../conversations/participants.js';
import { db } from '../db/client.js';
import { appConfig, projects } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { readSelvesFor } from '../orgs/agent-selves.js';
import { PROVIDER_HISTORY_WINDOW } from './context-budget.js';
import { appendUserMessage, openTurn, toProviderMessages } from './conversation-turn.js';
import { webConversationPersona } from './door-persona.js';
import { speakerSection } from './preference-line.js';
import { defaultChatProviderId } from './providers/bootstrap.js';
import { resolveForProject } from './providers/registry.js';
import { runChatTurn } from './run-turn.js';
import { buildSystemPrompt } from './system-prompt.js';
import { buildChatToolContext } from './tools/principal.js';
import { buildProjectToolset } from './tools/registry.js';
import { applyTurnContext } from './turn-context.js';

const chatRequestSchema = z
  .object({
    projectId: z.uuid(),
    message: z.string().min(1).max(40_000),
    conversationId: z.uuid().optional(),
    pageContext: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

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
    const { projectId, message, conversationId, pageContext } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

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

    // cm:guard a NEW web conversation gets a venue id of its own rather than reusing the row's: `(adapter, external_id)` is what a transport names a room by, and a web conversation's transport is the browser that opened it — minting the id here keeps the pair the single way in for every adapter, including this one.
    const turn = await openTurn({
      projectId,
      adapter: 'web',
      conversationId,
      ...(conversationId ? {} : { externalId: randomUUID() }),
      shape: 'direct',
      readerUserId: userId,
    });
    if (!conversationId) {
      await addPerson({ conversationId: turn.conversationId, userId, actorUserId: userId });
    }

    appendUserMessage(turn, message, { authorUserId: userId });

    // cm:guard this door takes the SAME persona the browser's conversation route takes, and passing none is what it used to do: `system-prompt.ts`'s fallback is one sentence with no method in it, so a turn here answered without the investigate-first and issue-quality rules every other door is held to (ISS-1007).
    // cm:guard the self is read off `turn.handleUserId` and the preferences off the signed-in person, the same two reads `external-chat.ts` makes for the browser door: a door that skipped either would answer as a nameless agent to a person whose style it ignores, and nothing else in the request would say so (ISS-1034 criteria 3, 17).
    const selves = turn.handleUserId ? await readSelvesFor([turn.handleUserId], db) : new Map();
    const systemPrompt = buildSystemPrompt({
      project,
      self: turn.handleUserId ? (selves.get(turn.handleUserId) ?? null) : null,
      appConfig: appCfg ?? null,
      persona: webConversationPersona(project.name, project.slug, null),
    });
    const speakerContext = speakerSection({
      speakerUserId: userId,
      speakerLabel: null,
      preferences: await readAssistantPreferences(userId, db),
    });
    const providerMessages = applyTurnContext(
      [
        { role: 'system' as const, content: systemPrompt },
        ...toProviderMessages(turn).slice(-PROVIDER_HISTORY_WINDOW),
      ],
      { pageContext, speakerContext },
    );

    // cm:guard the toolset is NOT read-only, and this annotation claimed it was until ISS-1005 measured it: `CHAT_TOOL_ALLOWLIST` permits `forge_issues` create and update and `forge_comments` create. The fence is `guardIssueWrites`, not absence — a created issue is forced to `draft` so it cannot auto-triage and spawn a run, `data.relations` is refused outright, and an update may only reach draft/waiting/needs_info/on_hold/closed. That fence is per-key and open by default, which is how `data.relations` reached chat unclassified in ISS-868 and let a room retract a live `blocks` edge, so a key added to the allowlist is unfenced until somebody classifies it. It IS fenced to this project and this caller, and widening it here widens it for every room.
    const tools = buildProjectToolset(
      buildChatToolContext({
        userId,
        projectId,
        projectSlug: project.slug,
        turn: {
          conversationId: turn.conversationId,
          speakerUserId: userId,
          handleUserId: turn.handleUserId,
        },
      }),
    );

    return runChatTurn({
      c,
      turn,
      resolved,
      providerMessages,
      tools,
      projectSlug: project.slug,
      userMessage: message,
      userKey: userId,
      adapter: 'web',
      contextBudgetTokens: env.CHAT_CONTEXT_BUDGET_TOKENS,
      reasoningEffort: env.CHAT_REASONING_EFFORT,
    });
  },
);
