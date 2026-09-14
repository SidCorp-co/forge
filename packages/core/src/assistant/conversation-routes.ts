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
import { resolveProjectHandle } from '../conversations/handles.js';
import {
  assertPersonReachesScope,
  projectsNamed,
  settleShape,
  shapeForHandleCount,
} from '../conversations/membership.js';
import { addHandle, addPerson, listParticipants } from '../conversations/participants.js';
import { derivedScope } from '../conversations/scope.js';
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
import { readableConversation, writableConversation } from './conversation-access.js';
import { conversationMemberRoutes } from './conversation-member-routes.js';
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
    /** Colleagues to open the room with, beside whoever is opening it. */
    people: z.array(z.uuid()).max(50).optional(),
    /** Agents to open the room with, beside the opening project's own. */
    handles: z
      .array(z.object({ projectId: z.uuid(), userId: z.uuid().optional() }).strict())
      .max(20)
      .optional(),
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

// cm:guard mounted at the ROOT of this router and not under a path of its own, because its routes are `/:id/...` on the same rooms: a caller reaching `/api/conversations/:id/people` is reaching the same resource `/api/conversations/:id` serves, and a second mount point would make the room's membership live at an address the room's own answer does not mention (ISS-1011).
conversationRoutes.route('/', conversationMemberRoutes);

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

    const handles = input.handles ?? [];
    const people = input.people ?? [];

    // cm:guard the people are checked against the scope the room will HAVE and not the one it is opened under, and they are checked BEFORE anything is written: a colleague who reaches the opening project but not the second agent's would otherwise be added to a room they cannot open, and told about it only after the room existed (ISS-1011 criteria 7, 39).
    const projected = [...new Set([input.projectId, ...handles.map((h) => h.projectId)])];
    for (const person of people) await assertPersonReachesScope(person, projected);

    const conversation = await openConversation({
      adapter: 'web',
      externalId: randomUUID(),
      // cm:guard the shape is settled from the handle count this room OPENS with, which is the opening project's own plus whatever was asked for — never patched afterwards, because a row that is `direct` for one statement is a row the one-to-one read fence answers for.
      shape: shapeForHandleCount(1 + handles.length),
      projectId: input.projectId,
      title: input.title ?? null,
    });
    await addPerson({ conversationId: conversation.id, userId, actorUserId: userId });
    for (const handle of handles) {
      await db.transaction(async (tx) => {
        await addHandle({
          conversationId: conversation.id,
          handleUserId: handle.userId ?? (await resolveProjectHandle(tx, handle.projectId)).userId,
          projectId: handle.projectId,
          actorUserId: userId,
          tx,
        });
        await settleShape(tx, conversation.id);
      });
    }
    for (const person of people) {
      await addPerson({ conversationId: conversation.id, userId: person, actorUserId: userId });
    }

    const [row] = await Promise.all([getConversation(conversation.id)]);
    return c.json(row ?? conversation, 201);
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
    const conversation = await readableConversation(id, userId);
    const [participants, messages, scope, windows] = await Promise.all([
      listParticipants(id),
      readMessages(id, READ_WINDOW),
      derivedScope(id),
      listWindowsForConversation(id, WINDOW_PAGE),
    ]);
    // cm:guard the projects are NAMED here rather than left as ids for the client to resolve: the scope is derived, so a screen printing it has no list of its own to look them up in, and a banner reading "this room is about 2 projects" with two uuids under it says nothing a person can act on (ISS-1011 criteria 5, 30).
    const scopeProjects = await projectsNamed(scope);
    return c.json({ ...conversation, scope, scopeProjects, participants, messages, windows });
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
    await writableConversation(id, userId);
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
    await writableConversation(id, userId);
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

    const conversation = await writableConversation(id, userId);
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
