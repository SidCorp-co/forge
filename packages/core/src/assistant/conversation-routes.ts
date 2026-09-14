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
import { eq } from 'drizzle-orm';
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
import { listWindowsForConversation } from '../conversations/windows.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { assertProjectRole, effectiveProjectRole, loadProjectAccess } from '../lib/authz.js';
import { fromPage, listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { sendWebConversationMessage } from './conversation-send.js';

const READ_WINDOW = 200;

/**
 * How many of a conversation's windows a read carries.
 */
// cm:guard enough to cover the message window above it — one window is at least one message, so a page of decisions can never be shorter than the page of messages it explains (ISS-1004 criterion 28).
const WINDOW_PAGE = READ_WINDOW;

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

const sendSchema = z.object({ content: z.string().min(1).max(40_000) }).strict();

/** A room's name, taken from the first thing said in it. */
// cm:guard cut on a CHARACTER count and not on a word boundary, and never asked of a model: a title is a label in a list, an auto-title turn is a second model call a person is waiting behind, and the first sentence of what they typed is what they would have written anyway.
const ROOM_NAME_MAX = 80;
function roomNameFrom(content: string): string {
  const line = content.trim().split('\n')[0]?.trim() ?? '';
  return line.length > ROOM_NAME_MAX ? `${line.slice(0, ROOM_NAME_MAX - 1)}…` : line;
}

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const conversationRoutes = new Hono<{ Variables: AuthVars }>();
conversationRoutes.use('*', requireAuth(), assertEmailVerified());

/**
 * A one-to-one room is read by the people IN it, whatever roles its scope would grant.
 */
// cm:guard the scope check alone is the wrong rule for a `direct` room and became a live hole the moment a screen read this router: `derivedScope` answers what the room is ABOUT, so every member of the project passed it and one person's private chat was readable by all of them. `agent_sessions` has had this fence since ISS-522 (`eq(agentSessions.userId, userId)` on the interactive list) and the conversation store never needed one because nothing read it (ISS-1004 step 5).
// cm:guard it refuses a `direct` room whose people were never recorded — a Rocket.Chat DM, where the collector opens the venue and adds no person — rather than falling back to the scope check. Nobody reading such a room in the Forge UI is the safe half of the trade and the visible one; the other half would be handing Bob the transcript of Alice's DM with the bot.
async function assertInTheRoom(row: ConversationRow, userId: string): Promise<void> {
  if (row.shape !== 'direct') return;
  const people = await listParticipants(row.id);
  if (people.some((p) => p.kind === 'person' && p.userId === userId)) return;
  throw new HTTPException(403, {
    message: `conversation ${row.id} is a one-to-one room and you are not one of its people, so there is nothing here for you to read`,
    cause: { code: 'NOT_IN_THE_ROOM' },
  });
}

async function readable(id: string, userId: string): Promise<ConversationRow> {
  const row = await getConversation(id);
  if (!row) throw notFound('conversation not found');
  await assertConversationReadable(row.id, userId);
  await assertInTheRoom(row, userId);
  return row;
}

/** Renaming and deleting are writes, and a write takes more than a look. */
async function writable(id: string, userId: string): Promise<ConversationRow> {
  const row = await getConversation(id);
  if (!row) throw notFound('conversation not found');
  await assertConversationWritable(row.id, userId);
  await assertInTheRoom(row, userId);
  return row;
}

/**
 * The one project a web turn runs under.
 */
// cm:guard a room bound to more than one project is REFUSED by name rather than answered under the first of them: the turn reads and acts under one project's access, and picking one of two would answer a question about project B with project A's tools and say nothing about having done so.
function soleProject(row: ConversationRow, scope: string[]): string {
  const only = scope[0];
  if (scope.length !== 1 || !only) {
    throw new HTTPException(409, {
      message: `conversation ${row.id} is about ${scope.length} projects (${scope.join(', ') || 'none'}) and a turn runs under exactly one, so there is no project for this message to be answered under`,
      cause: { code: 'CONVERSATION_SCOPE_AMBIGUOUS' },
    });
  }
  return only;
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

    // cm:guard the rooms are filtered by the DERIVED scope BEFORE the page is cut and `total` counts what survived: paginating first returns a short page, hides the rooms behind it, and over-counts.
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
      // cm:guard the same one-to-one fence `assertInTheRoom` applies to a read, applied to the LIST: a room a caller would be refused on opening has no business appearing in their list with its title and its preview, which is most of what it holds.
      if (ok && row.shape === 'direct') {
        const people = await listParticipants(row.id);
        ok = people.some((p) => p.kind === 'person' && p.userId === userId);
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
    const [participants, messages, scope, windows] = await Promise.all([
      listParticipants(id),
      readMessages(id, READ_WINDOW),
      derivedScope(id),
      listWindowsForConversation(id, WINDOW_PAGE),
    ]);
    return c.json({ ...conversation, scope, participants, messages, windows });
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

/**
 * Say something in this room, and get back what the room now holds.
 */
// cm:guard the turn is routed INLINE and the whole thread comes back with it, rather than answered by a socket the caller then has to wait on: the person pressing enter is the one waiting, and an endpoint that returned 202 would make a delivered answer and a lost one look identical to the only client that could tell. The socket push in `conversation-adapter.ts:deliver` is for the OTHER tabs (ISS-1004 step 5).
// cm:guard the message is COLLECTED before it is answered and the two are one commit, which is what `collect-inbound.ts` is for: a send whose turn throws still leaves the question in the log, so it is a window somebody can route rather than a message the product forgot (ISS-1004 rule 1).
conversationRoutes.post(
  '/:id/messages',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', sendSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { content } = c.req.valid('json');
    const userId = c.get('userId');

    const conversation = await writable(id, userId);
    if (conversation.adapter !== 'web') {
      throw new HTTPException(409, {
        message: `conversation ${id} is a ${conversation.adapter} room, and the Forge UI speaks only in the rooms it opened — answer there instead`,
        cause: { code: 'CONVERSATION_NOT_WEB' },
      });
    }
    const scope = await derivedScope(id);
    const projectId = soleProject(conversation, scope);

    const [me] = await db
      .select({ displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const sent = await sendWebConversationMessage({
      room: { id: conversation.id, externalId: conversation.externalId, shape: conversation.shape },
      projectId,
      userId,
      userLabel: me?.displayName ?? me?.email ?? null,
      content,
    });

    // cm:guard the room is named from its FIRST message and only its first: a list of rooms all reading "New conversation" is a list nobody can pick from, and renaming on every message would overwrite a name a person typed. `seq === 0` is the one moment both are false.
    if (conversation.title === null && sent.seq === 0) {
      await renameConversation(id, roomNameFrom(content));
    }

    const [messages, windows] = await Promise.all([
      readMessages(id, READ_WINDOW),
      listWindowsForConversation(id, WINDOW_PAGE),
    ]);
    return c.json({ ...sent, messages, windows }, 201);
  },
);
