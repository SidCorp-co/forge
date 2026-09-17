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
import { resolveProjectHandle } from '../conversations/handles.js';
import {
  assertPersonReachesScope,
  projectsNamed,
  settleShape,
} from '../conversations/membership.js';
import { addHandle, addPerson, listParticipants } from '../conversations/participants.js';
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
import { conversationMemberRoutes } from './conversation-member-routes.js';
import { withDisplayNames } from './conversation-people.js';
import { ConversationModeSettledError, sendWebConversationMessage } from './conversation-send.js';

const READ_WINDOW = 200;

/**
 * How many of a conversation's windows a read carries.
 */
// cm:guard enough to cover the message window above it — one window is at least one message, so a page of decisions can never be shorter than the page of messages it explains (ISS-1004 criterion 28).
const WINDOW_PAGE = READ_WINDOW;

const idParamSchema = z.object({ id: z.uuid() });

// cm:guard `archived` is an explicit four-value literal and NOT `z.coerce.boolean()`, which reads
// the string "false" as true and would answer a caller asking for live rooms with the archived
// ones: a query parameter arrives as text, and the coercion that looks right here is the one that
// silently inverts the filter (ISS-1028).
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

// cm:guard a body holding NEITHER field is refused by name rather than answered 200 having written
// nothing: `title` was required before this, so an empty object was already a 400, and widening it
// to optional without this refinement would have turned every malformed rename into a silent no-op
// the caller reads as a success (ISS-1028).
const patchSchema = z
  .object({
    title: z.string().max(500).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.archived !== undefined, {
    error: 'a PATCH body must carry `title` (a string or null) or `archived` (a boolean), or both',
  });

// cm:guard `mode` is OPTIONAL and a body carrying it into a room that already holds a message is
// refused by name rather than accepted and ignored: a client that believes it switched lanes over a
// room that did not is the defect the whole first-send rule exists to prevent. There is no value of
// this field that means "leave it as it is" — absence means that (ISS-1039).
const sendSchema = z
  .object({
    content: z.string().min(1).max(40_000),
    mode: z.enum(conversationModes).optional(),
    /**
     * The caller's own id for this message, echoed on `conversation.accepted`.
     */
    // cm:guard OPTIONAL, and a send without one is not refused: the token is the sender's private
    // bookkeeping — it matches the accepted frame to the row a tab is holding in its outbox — and no
    // server behaviour turns on it. A required one would refuse every caller that does not keep an
    // outbox, which is every caller but the Forge UI (ISS-1078).
    clientToken: z.string().min(1).max(200).optional(),
  })
  .strict();

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
    const { projectId, page, pageSize, archived } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const rows = await listConversationsInProject(projectId, { archived });

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

/**
 * Whether a NEW conversation in this project could be opened in Agent mode.
 */
// cm:guard a door of its own, because the composer's first question is asked before any room exists:
// a draft has no conversation to read `agentMode` off, and the screen was offering Agent enabled on
// the strength of nothing — so a person on a project with no box paired composed a question, spent a
// send, and learned only from the refusal. The issue asks for the control disabled and EXPLAINED
// before a message is spent, which cannot be answered by the room's own read (ISS-1039, commit
// consult F5).
// cm:guard it answers the same two sentences `agentModeOffer` does and never a third: one probe, one
// vocabulary, so a draft and a room cannot disagree about the same fleet.
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
        : { available: false, reason: 'this project has no box paired' },
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

    // cm:guard the WHOLE opening is one transaction — the room, its own handle, the opener, every agent named, every colleague named and the shape that follows from them. A room opened in a transaction of its own leaves a committed room behind every refusal the membership doors make afterwards: a room nobody asked for holding half the people they named, with the request they made reported as a failure (ISS-1011, review F1).
    const conversation = await db.transaction(async (handle) => {
      const tx = handle as unknown as typeof db;
      const room = await openConversationIn(tx, {
        adapter: 'web',
        externalId: randomUUID(),
        // cm:guard opened `direct` and PROMOTED from the live rows at the end, rather than computed from how many agents were asked for: a request naming the project's own handle, or naming one twice, is a request for fewer live handles than entries, and a shape read off the entry count would make such a room readable by everyone with a role on its project while holding one agent. Nothing can observe the intermediate value, because it never commits (ISS-1011, review F3).
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
      // cm:guard the people are checked against the scope the room ENDED UP with, read back from the rows rather than projected from the request: the projection cannot know that a named agent was already the room's own, and a colleague refused on a project the room does not actually hold is a refusal about nothing.
      const scope = await derivedScope(room.id, tx);
      for (const person of people) {
        await assertPersonReachesScope(person, scope, tx);
        await addPerson({ conversationId: room.id, userId: person, actorUserId: userId, tx });
      }
      // cm:guard settled AFTER the people as well as the handles, and with no change named: a room opened already holding two people is a group from its first row and owes its readers no line about why (ISS-1034 criteria 41, 42).
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
    // cm:guard the projects are NAMED here rather than left as ids for the client to resolve: the scope is derived, so a screen printing it has no list of its own to look them up in, and a banner reading "this room is about 2 projects" with two uuids under it says nothing a person can act on (ISS-1011 criteria 5, 30).
    const scopeProjects = await projectsNamed(scope);
    return c.json({
      ...conversation,
      scope,
      scopeProjects,
      // cm:guard the CAPABILITY travels with the room rather than being derived on the client from a project role: a group room is readable by anybody holding a role on its projects, and a screen deciding on that alone offers Add agent to somebody every press of which is refused (ISS-1011, review F6).
      canChangeMembership: await mayChangeMembership(conversation, userId),
      // cm:guard SERVED and not derived on the client, the same rule `canChangeMembership` follows
      // one line above: whether a box could take a turn is a fleet read the browser cannot make, and
      // a composer that guessed would offer a control every press of which is refused. It is only
      // meaningful while `mode` is null, which is the one moment the control is on screen (ISS-1039).
      agentMode: await agentModeOffer(conversation, scope, messages.length),
      // cm:guard the FOUR states, served per window, for the reason the states exist: a thread that
      // showed one blank gap for dispatched, running, delivered and failed is this feature failing in
      // the field (ISS-1039).
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
    const { title, archived } = c.req.valid('json');
    const userId = c.get('userId');
    await writableConversation(id, userId);
    // cm:guard both writes RUN when both fields are sent, rather than the first one winning an
    // if/else: a body carrying a rename and an archive together is one act to the caller, and an
    // else-branch here silently drops the archive and answers 200 with the renamed row. Both
    // writers return the whole of `selection`, so whichever runs last answers completely.
    let updated: ConversationRow | null = null;
    if (title !== undefined) updated = await renameConversation(id, title);
    if (archived !== undefined) updated = await setConversationArchived(id, archived);
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
    const { content, mode, clientToken } = c.req.valid('json');
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

    // cm:guard the read is "does this room hold a message", not "is its mode column set": a room
    // opened before ISS-1039 has a null mode and a transcript, and it answers in `assistant` — so a
    // body naming a mode for it is refused naming `assistant` rather than silently settling one
    // over a conversation already under way (ISS-1039, plan consult F6).
    const already = await readMessages(id, 1);
    const settled = conversation.mode !== null || already.length > 0;
    if (mode !== undefined && settled) {
      throw new HTTPException(409, {
        message: `conversation ${id} already answers in ${effectiveConversationMode(conversation)} mode; a room's mode is written by its first message and never changes, so open another conversation to talk to the other one`,
        cause: { code: 'CONVERSATION_MODE_SETTLED' },
      });
    }
    // cm:guard refused BEFORE the message is collected and never after: a person who asked for a box
    // has spent nothing yet, and the alternative — collect it and answer in Assistant mode — is the
    // silent fall back this issue forbids by name. The composer offers Agent disabled for the same
    // reason; this is the floor under a device that goes away between the pick and the send.
    const asking = mode ?? effectiveConversationMode(conversation);
    if (asking === 'agent' && !(await conversationAgentDeviceAvailable(projectId))) {
      throw new HTTPException(409, {
        message: `no paired device is free to take an Agent turn for project ${projectId}, so this message was not taken in — nothing was answered in Assistant mode in its place`,
        cause: { code: 'CONVERSATION_AGENT_NO_DEVICE', details: { projectId } },
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
      });
    } catch (err) {
      // cm:guard the LOSER of two first sends racing in one empty room, which the read above cannot
      // catch because both of them passed it: the settle inside the collector is the admission, and
      // this is that refusal reaching the caller with the winner's mode named (ISS-1039, F2).
      if (err instanceof ConversationModeSettledError) {
        throw new HTTPException(409, {
          message: `conversation ${id} was opened in ${err.settled} mode by a message that landed first; this one was not taken in — send it again, or open another conversation to talk to the other mode`,
          cause: { code: 'CONVERSATION_MODE_SETTLED' },
        });
      }
      throw err;
    }

    // cm:guard the room is named from its FIRST message and only its first: a list of rooms all reading "New conversation" is a list nobody can pick from, and renaming on every message would overwrite a name a person typed. `seq === 0` is the one moment both are false.
    if (conversation.title === null && sent.seq === 0) {
      await renameConversation(id, roomNameFrom(content));
    }

    const [messages, windows, agentTurns] = await Promise.all([
      readMessages(id, READ_WINDOW),
      listWindowsForConversation(id, WINDOW_PAGE),
      readConversationAgentTurns(id),
    ]);
    // cm:guard 202 for an Agent turn and 201 for an Assistant one, and the split is the honest
    // half of the fork rather than decoration: 201 says the thing this call was for is in the body,
    // which is true of an inline answer and false of a turn a box has only just been asked to take.
    // A caller reading 201 here would show the room as settled with nothing in it (ISS-1039).
    return c.json({ ...sent, messages, windows, agentTurns }, sent.mode === 'agent' ? 202 : 201);
  },
);
