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
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { readConversationAgentTurns } from '../agent-sessions/conversation-agent.js';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import {
  assertPersonReachesScope,
  projectsNamed,
  settleShape,
} from '../conversations/membership.js';
import { addHandle, addPerson, listParticipants } from '../conversations/participants.js';
import { PresenceValidationError, validateRoomPresence } from '../conversations/presence.js';
import { roomGone, roomRefusal, withoutUnsavedRoom } from '../conversations/room-refusal.js';
import { derivedScope } from '../conversations/scope.js';
import { nameSpeakers } from '../conversations/speaker-names.js';
import {
  type ConversationRow,
  deleteConversation,
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
import { conversationModes } from '../db/schema-conversations.js';
import { assertRoleFor, loadProjectAccess } from '../lib/authz.js';
import { fromPage, listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  assertMayStartRoom,
  mayChangeMembership,
  readableConversation,
  scopeIfReadable,
  writableConversation,
} from './conversation-access.js';
import { deleteAndTellReaders } from './conversation-adapter.js';
import { agentModeOffer, projectAgentModeOffer } from './conversation-agent-offer.js';
import { conversationAttachmentRoutes } from './conversation-attachment-routes.js';
import { conversationMemberRoutes } from './conversation-member-routes.js';
import { withDisplayNames } from './conversation-people.js';
import {
  agentModeOfferSchema,
  changeRoom,
  conversationDetailSchema,
  conversationListSchema,
  conversationSchema,
  deleteRoom,
  listRooms,
  openRoom,
  readAgentModeOffer,
  readRoom,
  sendToRoom,
  sentSchema,
} from './conversation-routes-reference.js';
import type { WebSendResult } from './conversation-send.js';
import { repeatedWebSend } from './repeated-send.js';
import { takeWebSend } from './take-web-send.js';

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
     * The caller's own id for this message, echoed on `conversation.accepted`. A send repeating a
     * token its caller already sent in this room writes nothing and is answered with that message.
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

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const conversationRoutes = new Hono<{ Variables: AuthVars }>();
conversationRoutes.use('*', requireAuth(), assertEmailVerified());

conversationRoutes.route('/', conversationMemberRoutes);
conversationRoutes.route('/', conversationAttachmentRoutes);

conversationRoutes.get(
  '/',
  listRooms,
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, page, pageSize, archived } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertRoleFor(access, 'viewer', 'read its conversations');

    const rows = await listConversationsInProject(projectId, { archived });

    const visible: Array<(typeof rows)[number] & { scope: string[] }> = [];
    for (const row of rows) {
      const scope = await scopeIfReadable(row, userId);
      if (scope) visible.push({ ...row, scope });
    }

    const offset = (page - 1) * pageSize;
    return c.json(
      answer(
        conversationListSchema,
        listResponse(
          c,
          visible.slice(offset, offset + pageSize),
          visible.length,
          fromPage(page, pageSize),
        ),
      ),
    );
  },
);

/**
 * Whether a NEW conversation in this project could be opened in Agent mode.
 */
conversationRoutes.get(
  '/agent-mode',
  readAgentModeOffer,
  zValidator('query', z.object({ projectId: z.uuid() }).strict(), (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    assertRoleFor(access, 'viewer', 'read whether it offers Agent mode');
    return c.json(answer(agentModeOfferSchema, await projectAgentModeOffer(projectId)));
  },
);

conversationRoutes.post(
  '/',
  openRoom,
  zValidator('json', createSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    await assertMayStartRoom(input.projectId, userId);

    const handles = input.handles ?? [];
    const people = input.people ?? [];

    // A refusal while the room is being made rolls it back, so its details name no room (r30, judge-86).
    let opening: string | null = null;
    const conversation = await db
      .transaction(async (handle) => {
        const tx = handle as unknown as typeof db;
        const room = await openConversationIn(tx, {
          adapter: 'web',
          externalId: randomUUID(),
          shape: 'direct',
          projectId: input.projectId,
          title: input.title ?? null,
          createdBy: userId,
        });
        opening = room.id;
        await addPerson({ conversationId: room.id, userId, actorUserId: userId, tx });
        for (const named of handles) {
          await addHandle({
            conversationId: room.id,
            ...(named.userId ? { handleUserId: named.userId } : {}),
            projectId: named.projectId,
            actorUserId: userId,
            tx,
          });
        }
        const scope = await derivedScope(room.id, tx);
        for (const person of people) {
          await assertPersonReachesScope(room.id, person, scope, tx);
          await addPerson({ conversationId: room.id, userId: person, actorUserId: userId, tx });
        }
        await settleShape(tx, room.id);
        const settled = await getConversation(room.id, tx);
        return settled ?? room;
      })
      .catch((err: unknown) => {
        throw withoutUnsavedRoom(err, opening);
      });

    return c.json(answer(conversationSchema, conversation), 201);
  },
);

conversationRoutes.get(
  '/:id',
  readRoom,
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    const conversation = await readableConversation(id, userId);
    const [participants, messages, scope, windows, agentTurns] = await Promise.all([
      listParticipants(id),
      readMessages(id, READ_WINDOW).then((read) => nameSpeakers(read, userId)),
      derivedScope(id),
      listWindowsForConversation(id, WINDOW_PAGE),
      readConversationAgentTurns(id),
    ]);
    const scopeProjects = await projectsNamed(scope);
    return c.json(
      answer(conversationDetailSchema, {
        ...conversation,
        scope,
        scopeProjects,
        canChangeMembership: await mayChangeMembership(conversation, userId),
        agentMode: await agentModeOffer(conversation, scope, messages.length),
        agentTurns,
        participants: await withDisplayNames(participants),
        messages,
        windows,
      }),
    );
  },
);

conversationRoutes.patch(
  '/:id',
  changeRoom,
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
    if (!updated) throw roomGone(id);
    return c.json(answer(conversationSchema, updated));
  },
);

conversationRoutes.delete(
  '/:id',
  deleteRoom,
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await writableConversation(id, userId);
    await deleteAndTellReaders(id, (room) => deleteConversation(room));
    return c.body(null, 204);
  },
);

/**
 * Say something in this room, and get back what the room now holds.
 */
conversationRoutes.post(
  '/:id/messages',
  sendToRoom,
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', sendSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { clientToken } = c.req.valid('json');
    const userId = c.get('userId');

    const conversation = await writableConversation(id, userId);
    if (conversation.adapter !== 'web') {
      throw roomRefusal(
        409,
        'CONVERSATION_NOT_WEB',
        `This room is a ${conversation.adapter} room, and the Forge UI speaks only in the rooms it opened — answer there instead`,
        { conversationId: id },
      );
    }
    const repeat = () => repeatedWebSend({ conversationId: id, userId, clientToken });
    const early = await repeat();
    if (early) return c.json(...(await sentAnswer(id, userId, early)));
    // A refusal met after that lookup may be the first send under this token landing meanwhile.
    const sent = await takeWebSend(conversation, userId, c.req.valid('json')).catch(
      async (err: unknown) => (await repeat()) ?? Promise.reject(err),
    );
    return c.json(...(await sentAnswer(id, userId, sent)));
  },
);

/** A send's answer and status: what it did, and the room as its sender now reads it. */
async function sentAnswer(id: string, userId: string, sent: WebSendResult) {
  const [messages, windows, agentTurns] = await Promise.all([
    readMessages(id, READ_WINDOW).then((read) => nameSpeakers(read, userId)),
    listWindowsForConversation(id, WINDOW_PAGE),
    readConversationAgentTurns(id),
  ]);
  const body = answer(sentSchema, { ...sent, messages, windows, agentTurns });
  return [body, sent.mode === 'agent' ? 202 : 201] as const;
}
