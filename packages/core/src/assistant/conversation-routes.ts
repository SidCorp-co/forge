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
import {
  conversationAgentDeviceAvailable,
  readConversationAgentTurns,
} from '../agent-sessions/conversation-agent.js';
import { listConversationAttachmentsByIds } from '../conversations/attachment-service.js';
import { resolveProjectHandle } from '../conversations/handles.js';
import {
  assertPersonReachesScope,
  projectsNamed,
  settleShape,
} from '../conversations/membership.js';
import { addHandle, addPerson, listParticipants } from '../conversations/participants.js';
import { PresenceValidationError, validateRoomPresence } from '../conversations/presence.js';
import { derivedScope } from '../conversations/scope.js';
import {
  type ConversationRow,
  deleteConversation,
  effectiveConversationMode,
  getConversation,
  listConversationsInProject,
  openConversationIn,
  readMessages,
  renameConversation,
  setConversationArchived,
  setConversationPresence,
} from '../conversations/store.js';
import { listWindowsForConversation } from '../conversations/windows.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { conversationModes } from '../db/schema-conversations.js';
import { assertProjectRole, effectiveProjectRole, loadProjectAccess } from '../lib/authz.js';
import { fromPage, listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  mayChangeMembership,
  readableConversation,
  writableConversation,
} from './conversation-access.js';
import { agentModeOffer } from './conversation-agent-offer.js';
import { conversationAttachmentRoutes } from './conversation-attachment-routes.js';
import { foreignAttachmentIds, imagesFromAttachments } from './conversation-images.js';
import { conversationMemberRoutes } from './conversation-member-routes.js';
import { withDisplayNames } from './conversation-people.js';
import { ConversationModeSettledError, sendWebConversationMessage } from './conversation-send.js';

const READ_WINDOW = 200;

/**
 * How many of a conversation's windows a read carries.
 */
const WINDOW_PAGE = READ_WINDOW;

const idParamSchema = z.object({ id: z.uuid() });

const archivedQuery = z
  .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')], {
    error: "archived takes '1', '0', 'true' or 'false'",
  })
  .optional()
  .transform((v) => v === '1' || v === 'true');

const listQuerySchema = z
  .object({
    projectId: z.uuid(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    /** `1`/`true` lists ONLY the archived rooms; anything else lists only the live ones. */
    archived: archivedQuery,
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

const patchSchema = z
  .object({
    title: z.string().max(500).nullable().optional(),
    archived: z.boolean().optional(),
    presence: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.archived !== undefined || v.presence !== undefined, {
    error:
      'a PATCH body must carry `title` (a string or null), `archived` (a boolean) or `presence` (an object or null)',
  });

const sendSchema = z
  .object({
    content: z.string().max(40_000),
    mode: z.enum(conversationModes).optional(),
    /**
     * The caller's own id for this message, echoed on `conversation.accepted`.
     */
    clientToken: z.string().min(1).max(200).optional(),
    /**
     * Files already uploaded to THIS room, staged in its composer (ISS-1146).
     */
    attachmentIds: z.array(z.uuid()).max(10).optional(),
  })
  .strict()
  .refine((v) => v.content.trim().length > 0 || (v.attachmentIds?.length ?? 0) > 0, {
    error:
      'a message carries text, a file, or both — this one carries neither, so there is nothing to say',
  });

/** A room's name, taken from the first thing said in it. */
const ROOM_NAME_MAX = 80;
function roomNameFrom(content: string, attached: readonly { name: string }[]): string {
  const line = content.trim().split('\n')[0]?.trim() || (attached[0]?.name ?? '');
  return line.length > ROOM_NAME_MAX ? `${line.slice(0, ROOM_NAME_MAX - 1)}…` : line;
}

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const conversationRoutes = new Hono<{ Variables: AuthVars }>();
conversationRoutes.use('*', requireAuth(), assertEmailVerified());

conversationRoutes.route('/', conversationMemberRoutes);
conversationRoutes.route('/', conversationAttachmentRoutes);

/**
 * The one project a web turn runs under.
 */
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
    const { projectId, page, pageSize, archived } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const rows = await listConversationsInProject(projectId, { archived });

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

/**
 * Whether a NEW conversation in this project could be opened in Agent mode.
 */
conversationRoutes.get(
  '/agent-mode',
  zValidator('query', z.object({ projectId: z.uuid() }).strict(), (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    assertProjectRole(access, 'viewer', 'not a project member');
    return c.json(
      (await conversationAgentDeviceAvailable(projectId))
        ? { available: true, reason: null }
        : { available: false, reason: 'this project has no runner paired' },
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

    const conversation = await db.transaction(async (handle) => {
      const tx = handle as unknown as typeof db;
      const room = await openConversationIn(tx, {
        adapter: 'web',
        externalId: randomUUID(),
        shape: 'direct',
        projectId: input.projectId,
        title: input.title ?? null,
      });
      await addPerson({ conversationId: room.id, userId, actorUserId: userId, tx });
      for (const named of handles) {
        await addHandle({
          conversationId: room.id,
          handleUserId: named.userId ?? (await resolveProjectHandle(tx, named.projectId)).userId,
          projectId: named.projectId,
          actorUserId: userId,
          tx,
        });
      }
      const scope = await derivedScope(room.id, tx);
      for (const person of people) {
        await assertPersonReachesScope(person, scope, tx);
        await addPerson({ conversationId: room.id, userId: person, actorUserId: userId, tx });
      }
      await settleShape(tx, room.id);
      const settled = await getConversation(room.id, tx);
      return settled ?? room;
    });

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
    const conversation = await readableConversation(id, userId);
    const [participants, messages, scope, windows, agentTurns] = await Promise.all([
      listParticipants(id),
      readMessages(id, READ_WINDOW),
      derivedScope(id),
      listWindowsForConversation(id, WINDOW_PAGE),
      readConversationAgentTurns(id),
    ]);
    const scopeProjects = await projectsNamed(scope);
    return c.json({
      ...conversation,
      scope,
      scopeProjects,
      canChangeMembership: await mayChangeMembership(conversation, userId),
      agentMode: await agentModeOffer(conversation, scope, messages.length),
      agentTurns,
      participants: await withDisplayNames(participants),
      messages,
      windows,
    });
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
    const { title, archived, presence } = c.req.valid('json');
    const userId = c.get('userId');
    await writableConversation(id, userId);
    let roomPresence: ReturnType<typeof validateRoomPresence> | null | undefined;
    if (presence !== undefined) {
      try {
        roomPresence = presence === null ? null : validateRoomPresence(presence);
      } catch (err) {
        if (err instanceof PresenceValidationError) {
          throw new HTTPException(400, {
            message: err.message,
            cause: { code: 'PRESENCE_INVALID', issues: err.issues },
          });
        }
        throw err;
      }
    }
    let updated: ConversationRow | null = null;
    if (title !== undefined) updated = await renameConversation(id, title);
    if (archived !== undefined) updated = await setConversationArchived(id, archived);
    if (roomPresence !== undefined) updated = await setConversationPresence(id, roomPresence);
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
    const { content, mode, clientToken, attachmentIds } = c.req.valid('json');
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

    const already = await readMessages(id, 1);
    const settled = conversation.mode !== null || already.length > 0;
    if (mode !== undefined && settled) {
      throw new HTTPException(409, {
        message: `conversation ${id} already answers in ${effectiveConversationMode(conversation)} mode; a room's mode is written by its first message and never changes, so open another conversation to talk to the other one`,
        cause: { code: 'CONVERSATION_MODE_SETTLED' },
      });
    }
    const asking = mode ?? effectiveConversationMode(conversation);
    if (asking === 'agent' && !(await conversationAgentDeviceAvailable(projectId))) {
      throw new HTTPException(409, {
        message: `no paired device is free to take an Agent turn for project ${projectId}, so this message was not taken in — nothing was answered in Assistant mode in its place`,
        cause: { code: 'CONVERSATION_AGENT_NO_DEVICE', details: { projectId } },
      });
    }

    const attached = await listConversationAttachmentsByIds(id, attachmentIds ?? []);
    const foreign = foreignAttachmentIds(attachmentIds ?? [], attached);
    if (foreign.length > 0) {
      throw new HTTPException(409, {
        message: `attachment ${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not on conversation ${id}, so this message was not taken in — upload the file to this room and send its id, rather than citing one from another`,
        cause: { code: 'CONVERSATION_ATTACHMENT_FOREIGN', details: { attachmentIds: foreign } },
      });
    }

    const [me] = await db
      .select({ displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    let sent: Awaited<ReturnType<typeof sendWebConversationMessage>>;
    try {
      sent = await sendWebConversationMessage({
        room: {
          id: conversation.id,
          externalId: conversation.externalId,
          shape: conversation.shape,
        },
        projectId,
        userId,
        userLabel: me?.displayName ?? me?.email ?? null,
        content,
        mode: asking,
        namedMode: mode !== undefined,
        ...(clientToken ? { clientToken } : {}),
        ...(attached.length > 0 ? { images: imagesFromAttachments(attached) } : {}),
      });
    } catch (err) {
      if (err instanceof ConversationModeSettledError) {
        throw new HTTPException(409, {
          message: `conversation ${id} was opened in ${err.settled} mode by a message that landed first; this one was not taken in — send it again, or open another conversation to talk to the other mode`,
          cause: { code: 'CONVERSATION_MODE_SETTLED' },
        });
      }
      throw err;
    }

    if (conversation.title === null && sent.seq === 0) {
      await renameConversation(id, roomNameFrom(content, attached));
    }

    const [messages, windows, agentTurns] = await Promise.all([
      readMessages(id, READ_WINDOW),
      listWindowsForConversation(id, WINDOW_PAGE),
      readConversationAgentTurns(id),
    ]);
    return c.json({ ...sent, messages, windows, agentTurns }, sent.mode === 'agent' ? 202 : 201);
  },
);
