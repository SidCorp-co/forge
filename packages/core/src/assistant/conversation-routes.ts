// `/api/conversations` — the durable rooms, read by the scope they derive.
//
// Replaces `/api/chat/sessions`, whose list was "rows carrying this project id
// and this user id". A conversation carries neither, so the list is the rooms
// this project's handle speaks in, filtered to the ones the caller's roles
// reach.
//
// It lives HERE, beside the rest of the assistant, rather than under
// `conversations/`, because it is the Forge UI's own adapter and not part of the
// store: it opens `web` venues, which is what being that adapter means, and a
// store that knows one transport's name knows them all. `transport-free.test.ts`
// is the gate that keeps the store clean, and this file is what it would have
// had to carve an exception for.

import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { addPerson, listParticipants } from '../conversations/participants.js';
import {
  assertConversationReadable,
  assertConversationWritable,
  derivedScope,
} from '../conversations/scope.js';
import {
  type ConversationRow,
  deleteConversation,
  getConversation,
  listConversationsInProject,
  openConversation,
  readMessages,
  renameConversation,
} from '../conversations/store.js';
import { assertProjectRole, effectiveProjectRole, loadProjectAccess } from '../lib/authz.js';
import { fromPage, listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const READ_WINDOW = 200;

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z
  .object({
    projectId: z.uuid(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const createSchema = z
  .object({
    projectId: z.uuid(),
    title: z.string().max(500).nullable().optional(),
  })
  .strict();

const patchSchema = z.object({ title: z.string().max(500).nullable() }).strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const conversationRoutes = new Hono<{ Variables: AuthVars }>();
conversationRoutes.use('*', requireAuth(), assertEmailVerified());

async function readable(id: string, userId: string): Promise<ConversationRow> {
  const row = await getConversation(id);
  if (!row) throw notFound('conversation not found');
  await assertConversationReadable(row.id, userId);
  return row;
}

/** Renaming and deleting are writes, and a write takes more than a look. */
async function writable(id: string, userId: string): Promise<ConversationRow> {
  const row = await getConversation(id);
  if (!row) throw notFound('conversation not found');
  await assertConversationWritable(row.id, userId);
  return row;
}

conversationRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, page, pageSize } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const rows = await listConversationsInProject(projectId);

    // cm:guard the rooms are filtered by the DERIVED scope BEFORE the page is cut and `total` counts
    // what survived: paginating first returns a short page, hides the rooms behind it, and over-counts.
    // cm:why the role lookups are memoized per request because the rooms share their projects.
    const roleByProject = new Map<string, boolean>();
    const visible: ConversationRow[] = [];
    for (const row of rows) {
      const scope = await derivedScope(row.id);
      let ok = scope.length > 0;
      for (const pid of scope) {
        let held = roleByProject.get(pid);
        if (held === undefined) {
          held = Boolean((await effectiveProjectRole(userId, pid))?.role);
          roleByProject.set(pid, held);
        }
        if (!held) ok = false;
      }
      if (ok) visible.push(row);
    }

    const offset = (page - 1) * pageSize;
    return c.json(
      listResponse(
        c,
        visible.slice(offset, offset + pageSize),
        visible.length,
        fromPage(page, pageSize),
      ),
    );
  },
);

conversationRoutes.post(
  '/',
  zValidator('json', createSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(input.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    const conversation = await openConversation({
      adapter: 'web',
      externalId: randomUUID(),
      shape: 'direct',
      projectId: input.projectId,
      title: input.title ?? null,
    });
    await addPerson({ conversationId: conversation.id, userId, actorUserId: userId });

    return c.json(conversation, 201);
  },
);

conversationRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    const conversation = await readable(id, userId);
    const [participants, messages, scope] = await Promise.all([
      listParticipants(id),
      readMessages(id, READ_WINDOW),
      derivedScope(id),
    ]);
    return c.json({ ...conversation, scope, participants, messages });
  },
);

conversationRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', patchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { title } = c.req.valid('json');
    const userId = c.get('userId');
    await writable(id, userId);
    const updated = await renameConversation(id, title);
    if (!updated) throw notFound('conversation not found');
    return c.json(updated);
  },
);

conversationRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await writable(id, userId);
    await deleteConversation(id);
    return c.body(null, 204);
  },
);
