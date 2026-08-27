import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentSessions, agentSessionTurns, projects } from '../db/schema.js';
import { assertProjectRole } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import { openOneShotRun } from '../pipeline/runs.js';
import {
  broadcastSession,
  broadcastTurnAppended,
  broadcastTurnEdited,
  broadcastTurnTruncated,
} from './broadcast.js';
import {
  createChatSessionRow,
  dispatchChatTurn,
  noClaudeClient,
  resolveChatDevice,
} from './chat-turn.js';
import {
  assertAgentChatOwner,
  assertSessionOwnerOrAdmin,
  badRequest,
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
  syncTurnsWithMessages,
  truncateTurnsAfter,
} from './turns-helpers.js';

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

// NOTE: no auth middleware here — the aggregator (`routes.ts`) applies it
// once for the whole `/api/agent-sessions` surface before mounting this.
export const agentSessionTurnsRoutes = new Hono<{ Variables: AuthVars }>();

agentSessionTurnsRoutes.get(
  '/:id/turns',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', turnsQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
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
  zValidator('param', turnIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', editTurnBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id, turnId } = c.req.valid('param');
    const { content, expectedEditedAt } = c.req.valid('json');
    const userId = c.get('userId');

    const { session, access } = await ensureSessionMember(id, userId);
    assertProjectRole(access, 'member');
    assertSessionOwnerOrAdmin(session, access, userId);

    const turn = await findTurnInSession(id, turnId);
    if (!turn) throw notFound('turn not found');
    if (turn.role !== 'user') {
      throw new HTTPException(400, {
        message: 'only user turns can be edited',
        cause: { code: 'TURN_NOT_USER' },
      });
    }
    // Last-write-wins precondition: if the caller asserts it saw a specific
    // edited_at, reject when the row has changed since (ISO compare avoids
    // tz drift between Postgres and JS).
    if (expectedEditedAt !== undefined && expectedEditedAt !== null) {
      const current = turn.editedAt ? turn.editedAt.toISOString() : null;
      if (current !== expectedEditedAt) {
        throw new HTTPException(409, {
          message: 'turn was edited by someone else',
          cause: { code: 'TURN_STALE' },
        });
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
    const newContent = { value: { ...origObj, role: turn.role, content } };

    const [updatedTurn, updatedSession] = await db.transaction(async (tx) => {
      const [turnRow] = await tx
        .update(agentSessionTurns)
        .set({ content: newContent as never, editedAt: editNow })
        .where(eq(agentSessionTurns.id, turnId))
        .returning();
      if (!turnRow) throw notFound('turn not found');

      // Mirror into the legacy jsonb blob so resumable-session reads stay
      // consistent until the deprecation lands.
      const newMessages = replaceMessageAt(session.messages, turn.turnIndex, (entry) => {
        if (!entry || typeof entry !== 'object') return { content };
        return { ...(entry as Record<string, unknown>), content };
      });
      const [sessionRow] = await tx
        .update(agentSessions)
        .set({ messages: newMessages as never, updatedAt: editNow })
        .where(eq(agentSessions.id, id))
        .returning();
      if (!sessionRow) throw notFound('agent session not found');
      return [turnRow, sessionRow] as const;
    });

    broadcastTurnEdited(updatedSession, turnId);
    return c.json(updatedTurn);
  },
);

agentSessionTurnsRoutes.post(
  '/:id/turns/:turnId/regenerate',
  zValidator('param', turnIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id, turnId } = c.req.valid('param');
    const userId = c.get('userId');

    const { session, access } = await ensureSessionMember(id, userId);
    assertProjectRole(access, 'member');
    assertSessionOwnerOrAdmin(session, access, userId);

    if (session.status === 'running' || session.status === 'queued') {
      throw new HTTPException(409, {
        message: 'abort the in-flight turn before regenerating',
        cause: { code: 'SESSION_RUNNING' },
      });
    }

    const turn = await findTurnInSession(id, turnId);
    if (!turn) throw notFound('turn not found');

    const keepThrough = turn.role === 'assistant' ? turn.turnIndex - 1 : turn.turnIndex;
    const replayMessages = sliceMessagesThrough(session.messages, keepThrough);
    const lastUserEntry = [...replayMessages].reverse().find((m) => {
      return !!m && typeof m === 'object' && (m as { role?: string }).role === 'user';
    }) as { content?: unknown } | undefined;
    const targetMessage = extractPromptString(lastUserEntry?.content);
    if (!targetMessage) {
      throw new HTTPException(409, {
        message: 'no dispatchable prompt found before this turn',
        cause: { code: 'NO_DISPATCHABLE_PROMPT' },
      });
    }

    const client = await resolveChatDevice(session);
    if (!client.isLocal && !client.deviceId) throw noClaudeClient('session');

    const [project] = await db
      .select({ id: projects.id, slug: projects.slug, repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, session.projectId))
      .limit(1);
    if (!project) throw notFound('project not found');

    const priorMessages = replayMessages.slice(0, -1);
    const truncatedFromIndex = priorMessages.length;
    const regenNow = new Date();
    const locked = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(agentSessions)
        .set({
          messages: priorMessages as never,
          status: 'queued',
          failureReason: null,
          dispatchedAt: regenNow,
          updatedAt: regenNow,
        })
        .where(
          and(
            eq(agentSessions.id, id),
            eq(agentSessions.status, session.status),
            eq(agentSessions.updatedAt, session.updatedAt),
          ),
        )
        .returning();
      if (!row) return null;
      await truncateTurnsAfter(id, priorMessages.length - 1, tx);
      return row;
    });
    if (!locked) {
      throw new HTTPException(409, {
        message: 'session changed before regeneration could start',
        cause: { code: 'SESSION_STALE' },
      });
    }

    broadcastTurnTruncated(locked, truncatedFromIndex);
    const updated = await dispatchChatTurn({
      session: locked,
      project,
      client,
      message: targetMessage,
    });
    return c.json({ status: updated.status });
  },
);

agentSessionTurnsRoutes.post(
  '/:id/fork',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', forkBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { fromTurnId, title } = c.req.valid('json');
    const userId = c.get('userId');

    const { session, access } = await ensureSessionMember(id, userId);
    assertProjectRole(access, 'member');
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
    const { inserted, seedSync } = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(agentSessions)
        .values({
          projectId: session.projectId,
          userId: session.userId,
          deviceId: session.deviceId,
          pipelineRunId: forkRun.id,
          title: title ?? (session.title ? `${session.title} (fork)` : null),
          status: 'idle',
          repoPath: session.repoPath,
          messages: slicedMessages as never,
          metadata: newMetadata as never,
        })
        .returning();
      if (!row) throw new Error('agent_sessions: insert returned no row');
      // Materialize matching turn rows in the new session. We don't reuse the
      // parent ids — fresh ids isolate edits/regenerations per fork.
      const sync = await syncTurnsWithMessages(row.id, [], slicedMessages, tx);
      return { inserted: row, seedSync: sync };
    });
    for (const t of seedSync.appended) {
      broadcastTurnAppended(inserted, t);
    }

    broadcastSession(inserted, 'agent-session.created');

    await recordSessionCreatedActivity(inserted, userId);

    return c.json(inserted, 201);
  },
);

agentSessionTurnsRoutes.post(
  '/:id/rerun',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const { session } = await ensureSessionOwnerOrAdmin(id, userId);
    if (session.status === 'running' || session.status === 'queued') {
      throw new HTTPException(409, {
        message: 'wait for the in-flight turn before rerunning',
        cause: { code: 'SESSION_RUNNING' },
      });
    }

    const messages = Array.isArray(session.messages) ? session.messages : [];
    const firstUser = messages.find((m) => {
      return !!m && typeof m === 'object' && (m as { role?: string }).role === 'user';
    }) as { content?: unknown } | undefined;
    const prompt = extractPromptString(firstUser?.content);
    if (!prompt) {
      throw new HTTPException(400, {
        message: 'no user prompt to rerun',
        cause: { code: 'NO_PROMPT' },
      });
    }

    const client = await resolveChatDevice(session);
    if (!client.isLocal && !client.deviceId) throw noClaudeClient('session');

    const [project] = await db
      .select({ id: projects.id, slug: projects.slug, repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, session.projectId))
      .limit(1);
    if (!project) throw notFound('project not found');

    const inserted = await createChatSessionRow({
      projectId: session.projectId,
      userId: session.userId ?? userId,
      title: session.title ? `${session.title} (rerun)` : null,
      metadata: {
        ...((session.metadata ?? {}) as Record<string, unknown>),
        rerunOfSessionId: id,
      },
    });
    const updated = await dispatchChatTurn({
      session: inserted,
      project,
      client,
      message: prompt,
      broadcastEvent: 'agent-session.created',
    });

    await recordSessionCreatedActivity(updated, userId);

    return c.json(updated, 201);
  },
);
