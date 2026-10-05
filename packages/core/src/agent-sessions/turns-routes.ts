import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, restActor } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { openOneShotRun } from '../pipeline/index.js';
import {
  broadcastSession,
  broadcastTurnAppended,
  broadcastTurnEdited,
  broadcastTurnTruncated,
} from './broadcast.js';
import { createChatSessionRow } from './chat-turn.js';
import {
  authorizeInteractiveTurn,
  dispatchInteractiveTurn,
  resolveInteractiveClient,
} from './interactive-credential.js';
import { projectHandle } from './read.js';
import { refuseSession } from './refusals.js';
import { editUserTurn, insertForkedSession, requeueForRegeneration } from './service.js';
import {
  assertAgentChatOwner,
  assertSessionOwnerOrAdmin,
  ensureSessionMember,
  ensureSessionOwnerOrAdmin,
  idParamSchema,
  notFound,
} from './session-access.js';
import { recordSessionCreatedActivity } from './session-activity.js';
import {
  extractPromptString,
  findTurnInSession,
  loadTurns,
  replaceMessageAt,
  sliceMessagesThrough,
} from './turns-helpers.js';

function isUserEntry(m: unknown): boolean {
  return !!m && typeof m === 'object' && (m as { type?: string }).type === 'user';
}

const turnIdParamSchema = z.object({
  id: z.uuid(),
  turnId: z.uuid(),
});

const turnsQuerySchema = z.object({
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const editTurnBodySchema = z
  .object({
    content: z.string().min(1).max(40_000),
    expectedEditedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const forkBodySchema = z
  .object({
    fromTurnId: z.uuid(),
    title: z.string().min(1).max(500).optional(),
  })
  .strict();

export const agentSessionTurnsRoutes = new Hono<{ Variables: AuthVars }>();

agentSessionTurnsRoutes.get(
  '/:id/turns',
  zValidator('param', idParamSchema),
  zValidator('query', turnsQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { after, limit } = c.req.valid('query');
    const userId = c.get('userId');
    const { session, access } = await ensureSessionMember(id, userId);
    assertAgentChatOwner(session, access, userId);

    const opts: { afterTurnIndex?: number; limit?: number } = {};
    if (after) {
      const cursor = await findTurnInSession(id, after);
      if (!cursor) throw notFound('cursor turn not found');
      opts.afterTurnIndex = cursor.turnIndex;
    }
    if (limit !== undefined) opts.limit = limit;

    const result = await loadTurns(id, opts);
    return c.json(result);
  },
);

agentSessionTurnsRoutes.patch(
  '/:id/turns/:turnId',
  zValidator('param', turnIdParamSchema),
  zValidator('json', editTurnBodySchema),
  async (c) => {
    const { id, turnId } = c.req.valid('param');
    const { content, expectedEditedAt } = c.req.valid('json');
    const userId = c.get('userId');

    const { session, access } = await ensureSessionMember(id, userId);
    requireHeld(access, 'project.write');
    assertSessionOwnerOrAdmin(session, access, userId);

    if (session.status === 'running' || session.status === 'queued') {
      throw refuseSession('SESSION_RUNNING', 'abort the in-flight turn before editing it');
    }

    const turn = await findTurnInSession(id, turnId);
    if (!turn) throw notFound('turn not found');
    if (turn.role !== 'user') {
      throw refuseSession('TURN_NOT_USER', 'only user turns can be edited');
    }
    // Last-write-wins precondition: if the caller asserts it saw a specific
    // edited_at, reject when the row has changed since (ISO compare avoids
    // tz drift between Postgres and JS).
    if (expectedEditedAt !== undefined && expectedEditedAt !== null) {
      const current = turn.editedAt ? turn.editedAt.toISOString() : null;
      if (current !== expectedEditedAt) {
        throw refuseSession('TURN_STALE', 'turn was edited by someone else');
      }
    }

    const editNow = new Date();
    // Preserve the original entry's auxiliary fields (timestamp, attachments,
    // tool calls, …) while replacing the user-visible content. The row stores
    // the wrapped shape `{ value: <messageEntry> }`, so unwrap one level before
    // re-wrapping — otherwise we'd nest a second `value` and corrupt the row.
    const origValue = (turn.content as { value?: unknown }).value;
    const origObj =
      origValue && typeof origValue === 'object' ? (origValue as Record<string, unknown>) : {};
    const newContent = {
      value: {
        ...origObj,
        type: typeof origObj.type === 'string' ? origObj.type : 'user',
        content,
      },
    };

    // Mirror into the legacy jsonb blob so resumable-session reads stay
    // consistent until the deprecation lands.
    const newMessages = replaceMessageAt(session.messages, turn.turnIndex, (entry) => {
      if (!entry || typeof entry !== 'object') return { content };
      return { ...(entry as Record<string, unknown>), content };
    });
    const [updatedTurn, updatedSession] = await editUserTurn({
      sessionId: id,
      turnId,
      content: newContent,
      messages: newMessages,
      at: editNow,
    });

    broadcastTurnEdited(updatedSession, turnId);
    return c.json(updatedTurn);
  },
);

agentSessionTurnsRoutes.post(
  '/:id/turns/:turnId/regenerate',
  zValidator('param', turnIdParamSchema),
  async (c) => {
    const { id, turnId } = c.req.valid('param');
    const userId = c.get('userId');

    const { session, access } = await ensureSessionMember(id, userId);
    requireHeld(access, 'project.write');
    assertSessionOwnerOrAdmin(session, access, userId);

    if (session.status === 'running' || session.status === 'queued') {
      throw refuseSession('SESSION_RUNNING', 'abort the in-flight turn before regenerating');
    }

    const turn = await findTurnInSession(id, turnId);
    if (!turn) throw notFound('turn not found');

    const keepThrough = turn.role === 'assistant' ? turn.turnIndex - 1 : turn.turnIndex;
    const replayMessages = sliceMessagesThrough(session.messages, keepThrough);
    const lastUserEntry = [...replayMessages].reverse().find(isUserEntry) as
      | { content?: unknown }
      | undefined;
    const targetMessage = extractPromptString(lastUserEntry?.content);
    if (!targetMessage) {
      throw refuseSession(
        'NO_DISPATCHABLE_PROMPT',
        'no dispatchable prompt found before this turn',
      );
    }

    const client = await resolveInteractiveClient(session, { scope: 'session' });
    const authority = await authorizeInteractiveTurn({
      client,
      projectId: session.projectId,
      asker: { userId, viaTokenId: c.get('patTokenId') ?? null },
    });

    const project = await projectHandle(session.projectId);
    if (!project) throw notFound('project not found');

    const priorMessages = replayMessages.slice(0, -1);
    const truncatedFromIndex = priorMessages.length;
    const locked = await requeueForRegeneration({
      session,
      messages: priorMessages,
      actor: restActor(c),
    });
    if (!locked) {
      throw refuseSession('SESSION_STALE', 'session changed before regeneration could start');
    }

    broadcastTurnTruncated(locked, truncatedFromIndex);
    const updated = await dispatchInteractiveTurn({
      session: locked,
      project,
      client,
      authority,
      message: targetMessage,
    });
    return c.json({ status: updated.status });
  },
);

agentSessionTurnsRoutes.post(
  '/:id/fork',
  zValidator('param', idParamSchema),
  zValidator('json', forkBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { fromTurnId, title } = c.req.valid('json');
    const userId = c.get('userId');

    const { session, access } = await ensureSessionMember(id, userId);
    requireHeld(access, 'project.write');
    const turn = await findTurnInSession(id, fromTurnId);
    if (!turn) throw notFound('turn not found');

    // Eager copy: slice both the jsonb blob and the per-turn rows up through
    // (and including) the fork point. Storage cost is acceptable at our session
    // scale (cap < 40k tokens × N turns); avoiding copy-on-write keeps reads
    // simple and avoids cross-session FK juggling.
    const slicedMessages = sliceMessagesThrough(session.messages, turn.turnIndex);

    const prevMeta = (session.metadata ?? {}) as Record<string, unknown>;
    const newMetadata = {
      ...prevMeta,
      parentSessionId: id,
      forkedFromTurnId: fromTurnId,
    };

    // ISS-101 — forks are independent interactive sessions; give each its own run.
    const forkRun = await openOneShotRun({
      projectId: session.projectId,
      kind: 'interactive',
    });
    // Turn rows are materialized fresh; reusing the parent ids would tie a
    // fork's edits and regenerations to its parent.
    const { inserted, seedSync } = await insertForkedSession({
      projectId: session.projectId,
      userId: session.userId,
      deviceId: session.deviceId,
      pipelineRunId: forkRun.id,
      title: title ?? (session.title ? `${session.title} (fork)` : null),
      kind: 'chat',
      parentSessionId: session.id,
      status: 'idle',
      repoPath: session.repoPath,
      messages: slicedMessages,
      metadata: newMetadata as never,
    });
    for (const t of seedSync.appended) {
      broadcastTurnAppended(inserted, t);
    }

    broadcastSession(inserted, 'agent-session.created');

    await recordSessionCreatedActivity(inserted, restActor(c));

    return c.json(inserted, 201);
  },
);

agentSessionTurnsRoutes.post('/:id/rerun', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  const { session } = await ensureSessionOwnerOrAdmin(id, userId);
  if (session.status === 'running' || session.status === 'queued') {
    throw refuseSession('SESSION_RUNNING', 'wait for the in-flight turn before rerunning');
  }

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const firstUser = messages.find(isUserEntry) as { content?: unknown } | undefined;
  const prompt = extractPromptString(firstUser?.content);
  if (!prompt) {
    throw refuseSession('NO_PROMPT', 'no user prompt to rerun');
  }

  const client = await resolveInteractiveClient(session, { scope: 'session' });
  const authority = await authorizeInteractiveTurn({
    client,
    projectId: session.projectId,
    asker: { userId, viaTokenId: c.get('patTokenId') ?? null },
  });

  const project = await projectHandle(session.projectId);
  if (!project) throw notFound('project not found');

  const inserted = await createChatSessionRow({
    projectId: session.projectId,
    userId,
    title: session.title ? `${session.title} (rerun)` : null,
    parentSessionId: id,
    metadata: {
      ...((session.metadata ?? {}) as Record<string, unknown>),
      rerunOfSessionId: id,
    },
  });
  const updated = await dispatchInteractiveTurn({
    session: inserted,
    project,
    client,
    authority,
    message: prompt,
    broadcastEvent: 'agent-session.created',
  });

  await recordSessionCreatedActivity(updated, restActor(c));

  return c.json(updated, 201);
});
