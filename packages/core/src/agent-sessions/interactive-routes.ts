import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, restActor } from '../middleware/auth.js';
import { badRequest, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { broadcastSession } from './broadcast.js';
import { createChatSessionRow } from './chat-turn.js';
import {
  assertMayRunSession,
  authorizeInteractiveTurn,
  dispatchInteractiveTurn,
  resolveInteractiveClient,
} from './interactive-credential.js';
import { assertCallerDeclaresNoKind } from './kind-query.js';
import { sendBodySchema } from './lifecycle-schemas.js';
import { projectHandle } from './read.js';
import { refuseSession } from './refusals.js';
import { ensureSessionOwnerOrAdmin, withTranscript } from './session-access.js';
import { recordSessionCreatedActivity } from './session-activity.js';

const createSchema = z
  .object({
    projectId: z.uuid(),
    deviceId: z.uuid().nullable().optional(),
    title: z.string().max(500).nullable().optional(),
    repoPath: z.string().max(2000).nullable().optional(),
    claudeSessionId: z.string().max(500).nullable().optional(),
    metadata: z.unknown().optional(),
  })
  .strict();

export const agentSessionInteractiveRoutes = new Hono<{ Variables: AuthVars }>();

agentSessionInteractiveRoutes.post('/', zValidator('json', createSchema), async (c) => {
  const input = c.req.valid('json');
  const userId = c.get('userId');

  const access = await loadProjectAccess(input.projectId, userId);
  assertMayRunSession(access);

  const clientMetadata = input.metadata as Record<string, unknown> | null | undefined;
  assertCallerDeclaresNoKind(clientMetadata, badRequest);

  // Chat bootstrap: an EMPTY session row. The first turn is dispatched later
  // through `POST /send` → the shared chat-turn dispatcher (which picks the
  // device), so this path deliberately does NOT pin a device or dispatch.
  const inserted = await createChatSessionRow({
    projectId: input.projectId,
    userId,
    deviceId: input.deviceId ?? null,
    title: input.title ?? null,
    repoPath: input.repoPath ?? null,
    claudeSessionId: input.claudeSessionId ?? null,
    metadata: clientMetadata ?? null,
  });

  broadcastSession(inserted, 'agent-session.created');

  await recordSessionCreatedActivity(inserted, restActor(c));

  return c.json(await withTranscript(inserted, []), 201);
});
agentSessionInteractiveRoutes.post('/send', zValidator('json', sendBodySchema), async (c) => {
  const input = c.req.valid('json');
  const userId = c.get('userId');

  const { session } = await ensureSessionOwnerOrAdmin(input.sessionId, userId);
  if (session.status === 'running' || session.status === 'queued') {
    throw refuseSession(
      'SESSION_RUNNING',
      'The agent is still working on this conversation, under the access of the person whose turn it is. Wait for it to finish or stop it, then send.',
    );
  }

  // Resolve the client through the SHARED path: honour an explicit runner pick
  // (input.deviceId) when present, else reuse the session's pinned device,
  // else pick a fresh online runner (this is what fixes the web cold start — a
  // session created empty via `POST /` has no pin, so the old pin-only guard
  // 409'd forever). No online remote client → 409; a rejected explicit pick
  // gets the 'picked' wording so the user knows their choice was unavailable.
  const client = await resolveInteractiveClient(session, {
    overrideDeviceId: input.deviceId,
    scope: input.deviceId ? 'picked' : 'session',
  });
  const authority = await authorizeInteractiveTurn({
    client,
    projectId: session.projectId,
    asker: { userId, viaTokenId: c.get('patTokenId') ?? null },
  });

  const project = await projectHandle(session.projectId);
  if (!project) throw notFound('project not found');

  await dispatchInteractiveTurn({
    session,
    project,
    client,
    authority,
    message: input.message,
    claudeSessionId: input.claudeSessionId ?? null,
    attachmentIds: input.attachmentIds,
    model: input.model,
  });
  return c.json({ ok: true });
});
