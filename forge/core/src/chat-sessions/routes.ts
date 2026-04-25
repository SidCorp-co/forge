import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { chatSessionSources, chatSessions } from '../db/schema.js';
import { setTotalCount } from '../lib/pagination.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { userRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z
  .object({
    projectId: z.uuid(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const messageRoleSchema = z.enum(['user', 'assistant', 'system']);
const messageInputSchema = z
  .object({
    role: messageRoleSchema,
    content: z.union([z.string(), z.array(z.unknown())]),
  })
  .strict();

const createSchema = z
  .object({
    projectId: z.uuid(),
    title: z.string().max(500).nullable().optional(),
    source: z.enum(chatSessionSources).optional(),
    userKey: z.string().max(500).nullable().optional(),
    widgetUserId: z.string().max(500).nullable().optional(),
    metadata: z.unknown().optional(),
    messages: z.array(messageInputSchema).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    title: z.string().max(500).nullable().optional(),
    summary: z.string().max(20_000).nullable().optional(),
    metadata: z.unknown().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const messageBodySchema = z
  .object({
    role: messageRoleSchema.default('user'),
    content: z.union([z.string().min(1), z.array(z.unknown())]),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const chatSessionRoutes = new Hono<{ Variables: AuthVars }>();
chatSessionRoutes.use('*', requireAuth(), assertEmailVerified());

chatSessionRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, page, pageSize } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const where = and(eq(chatSessions.projectId, projectId), eq(chatSessions.userId, userId));

    const [totalRow] = await db.select({ n: count() }).from(chatSessions).where(where);
    setTotalCount(c, totalRow?.n ?? 0);

    const rows = await db
      .select()
      .from(chatSessions)
      .where(where)
      .orderBy(desc(chatSessions.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return c.json(rows);
  },
);

chatSessionRoutes.post(
  '/',
  zValidator('json', createSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(input.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const [inserted] = await db
      .insert(chatSessions)
      .values({
        projectId: input.projectId,
        userId,
        title: input.title ?? null,
        source: input.source ?? 'web',
        userKey: input.userKey ?? null,
        widgetUserId: input.widgetUserId ?? null,
        metadata: (input.metadata as never) ?? null,
        messages: (input.messages as never) ?? [],
      })
      .returning();
    if (!inserted) throw new Error('chat_sessions: insert returned no row');

    return c.json(inserted, 201);
  },
);

chatSessionRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
    if (!row) throw notFound('chat session not found');
    if (row.userId && row.userId !== userId) throw forbidden('not your chat session');

    const access = await loadProjectAccess(row.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    return c.json(row);
  },
);

chatSessionRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', patchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const [existing] = await db
      .select({ id: chatSessions.id, userId: chatSessions.userId, projectId: chatSessions.projectId })
      .from(chatSessions)
      .where(eq(chatSessions.id, id))
      .limit(1);
    if (!existing) throw notFound('chat session not found');
    if (existing.userId && existing.userId !== userId) throw forbidden('not your chat session');

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) updates.title = patch.title;
    if (patch.summary !== undefined) {
      updates.summary = patch.summary;
      updates.summarizedAt = patch.summary === null ? null : new Date();
    }
    if (patch.metadata !== undefined) updates.metadata = patch.metadata;

    const [updated] = await db
      .update(chatSessions)
      .set(updates)
      .where(eq(chatSessions.id, id))
      .returning();
    if (!updated) throw notFound('chat session not found');

    return c.json(updated);
  },
);

chatSessionRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [existing] = await db
      .select({ id: chatSessions.id, userId: chatSessions.userId })
      .from(chatSessions)
      .where(eq(chatSessions.id, id))
      .limit(1);
    if (!existing) throw notFound('chat session not found');
    if (existing.userId && existing.userId !== userId) throw forbidden('not your chat session');

    await db.delete(chatSessions).where(eq(chatSessions.id, id));
    return c.body(null, 204);
  },
);

/**
 * Append a message to the session and broadcast to the user's WS room.
 *
 * v0.1: this folds the legacy `POST /chat` shape into a session-scoped path.
 * It persists the user's message and updates `updatedAt`. **The actual LLM
 * round-trip (provider call + tool execution + streaming reply) is deferred**
 * — that needs the chat-prompt-builder + agent-runner services that have not
 * been ported to `forge/core`. Callers receive `{ session, message }` so the
 * UI can optimistically render; a follow-up patch will add the streaming
 * assistant reply via the existing `userRoom` channel.
 */
chatSessionRoutes.post(
  '/:id/message',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', messageBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { role, content } = c.req.valid('json');
    const userId = c.get('userId');

    const [existing] = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, id))
      .limit(1);
    if (!existing) throw notFound('chat session not found');
    if (existing.userId && existing.userId !== userId) throw forbidden('not your chat session');

    const access = await loadProjectAccess(existing.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const prior = Array.isArray(existing.messages) ? (existing.messages as unknown[]) : [];
    const message = { role, content, ts: new Date().toISOString() };
    const nextMessages = [...prior, message];

    const [updated] = await db
      .update(chatSessions)
      .set({ messages: nextMessages as never, updatedAt: new Date() })
      .where(eq(chatSessions.id, id))
      .returning();
    if (!updated) throw notFound('chat session not found');

    roomManager.publish(userRoom(userId), {
      event: 'chat.message',
      data: {
        sessionId: updated.id,
        projectId: updated.projectId,
        role,
      },
    });

    return c.json({ session: updated, message });
  },
);
