import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type AuthVars, restActor } from '../middleware/auth.js';
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
import { sendBodySchema, startBodySchema } from './lifecycle-schemas.js';
import { agentSessionsPorts } from './ports.js';
import { issueRefsOf, loadProjectBySlug, projectHandle } from './read.js';
import { refuseSession } from './refusals.js';
import { badRequest, ensureSessionOwnerOrAdmin, notFound } from './session-access.js';
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

  return c.json(inserted, 201);
});

/** A started session is titled by its issues when it names any, else by its prompt. */
async function startTitle(prompt: string, issueIds: string[] | undefined): Promise<string> {
  if (!issueIds || issueIds.length === 0) {
    return prompt
      .replace(/^You are working on issue:\s*/i, '')
      .replace(/^You are working on the following issues:\s*/i, '')
      .replace(/^You are working on:\s*/i, '')
      .slice(0, 120);
  }
  const rows = await issueRefsOf(issueIds);
  const refs = rows.map((r) => formatIssueRef(r.prefix, r.seq));
  if (refs.length === 1) return `${refs[0]} ${rows[0]?.title ?? ''}`.slice(0, 120);
  if (refs.length > 1) return refs.join(', ').slice(0, 120);
  return prompt.slice(0, 120);
}

/**
 * ISS-733 — a skillName must resolve to an install_only effective skill for
 * THIS project before it can ride turn 1 as a slash-command; otherwise any
 * caller could slash-inject an arbitrary command via /start.
 */
async function assertInstallOnlySkill(projectId: string, skillName: string): Promise<void> {
  const effective = await agentSessionsPorts().resolveRegisteredEffectiveSkills(projectId);
  if (!effective.some((s) => s.name === skillName && s.installOnly)) {
    throw badRequest({ message: `skillName '${skillName}' is not install_only for this project` });
  }
}

agentSessionInteractiveRoutes.post('/start', zValidator('json', startBodySchema), async (c) => {
  const input = c.req.valid('json');
  const userId = c.get('userId');

  if (input.type) {
    throw badRequest({
      type: 'typed agent sessions are unavailable without the retired desktop client',
    });
  }
  if (!input.prompt) {
    throw badRequest({ message: 'prompt is required' });
  }

  const project = await loadProjectBySlug(input.projectSlug);
  if (!project) throw notFound('project not found');

  const access = await loadProjectAccess(project.id, userId);
  assertMayRunSession(access);

  const client = await resolveInteractiveClient(
    { projectId: project.id, deviceId: null, metadata: null },
    { origin: input.origin, scope: 'project' },
  );
  const authority = await authorizeInteractiveTurn({
    client,
    projectId: project.id,
    asker: { userId, viaTokenId: c.get('patTokenId') ?? null },
  });

  const rawPrompt = input.prompt;

  const title = await startTitle(rawPrompt, input.issueIds);
  if (input.skillName) await assertInstallOnlySkill(project.id, input.skillName);

  const metadata: Record<string, unknown> = {};
  if (input.issueIds?.length === 1 && input.issueIds[0]) metadata.issueId = input.issueIds[0];
  const session = await createChatSessionRow({
    projectId: project.id,
    userId,
    title,
    repoPath: input.repoPath ?? null,
    metadata: Object.keys(metadata).length ? metadata : null,
  });
  const updated = await dispatchInteractiveTurn({
    session,
    project: { id: project.id, slug: project.slug },
    client,
    authority,
    message: rawPrompt,
    origin: input.origin ?? null,
    pageContext: input.pageContext ?? null,
    preBuilt: input.preBuilt ?? false,
    attachmentIds: input.attachmentIds,
    skillName: input.skillName ?? null,
    model: input.model,
    broadcastEvent: 'agent-session.created',
  });

  await recordSessionCreatedActivity(updated, restActor(c));
  return c.json(updated, 201);
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
    origin: input.origin,
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
    origin: input.origin ?? null,
    pageContext: input.pageContext ?? null,
    claudeSessionId: input.claudeSessionId ?? null,
    attachmentIds: input.attachmentIds,
    model: input.model,
  });
  return c.json({ ok: true });
});
