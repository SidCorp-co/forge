// A master edits or deletes its own room post (ISS-1238, FB-643): two step messages posted for the
// owner's guide could not be taken back, since the master-posts door posted and did nothing else.
// A post is the master's own where its record (`master-post.ts`, tool `master_post`, the chat
// message as `externalId`) names the caller as `by` and the caller's project as the one it was made
// for. Only within `SUPPORT_MASTER_POST_EDIT_WINDOW_MS` of posting: past it a correction is a new
// post, since people have read the old one. An edit is scrubbed and screened as the post was, and
// goes out through the outbound door's proof; a delete takes the post's images or PDF with it. Each
// act is recorded on the room with who and when; a refusal changes nothing in the room.

import { SUPPORT_MASTER_POST_EDIT_WINDOW_MS } from '@forge/contracts/support';
import { supportMasterPostEditRequestSchema } from '@forge/contracts/support-channel';
import { asc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { deleteRoomMessage, editProvenReply } from '../integrations/rocketchat/index.js';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan, requiresOnParam } from '../permissions/index.js';
import { askerOf, mentionRefusal } from './channel.js';
import { readersOf } from './grants.js';
import { TOOL } from './master-post.js';
import { no, type Outcome } from './outcome.js';
import { roomIsBound } from './rooms.js';
import { screenForThread } from './screen.js';
import { type ActionRow, insertAction, type RoomRow, roomById } from './store.js';
import { roomAuth, scrubbedForRoom, TOP_LEVEL } from './thread.js';

const EDIT_TOOL = 'master_post_edit';
const DELETE_TOOL = 'master_post_delete';
const WINDOW_MINUTES = SUPPORT_MASTER_POST_EDIT_WINDOW_MS / 60_000;
const NOTHING = 'Nothing was changed in the room.';

type Actor = { userId: string; projectId: string };

/** A post of the caller's own, still within its window, and what the room shows of it now. */
interface OwnPost {
  post: ActionRow;
  room: RoomRow;
  team: boolean;
  /** The text the room shows: the last edit's, else the post's. */
  text: string;
  /** The messages its images or PDF went out as. */
  files: string[];
}

type PostInput = { text?: unknown; by?: unknown; for?: unknown; attachments?: unknown };

/** Every record naming chat message `messageId`, oldest first. */
async function recordsOf(messageId: string): Promise<ActionRow[]> {
  return db
    .select()
    .from(supportActions)
    .where(eq(supportActions.externalId, messageId))
    .orderBy(asc(supportActions.createdAt));
}

const isPost = (r: ActionRow) => r.tool === TOOL && (r.kind === 'routed' || r.kind === 'announced');
const isAct = (tool: string) => (r: ActionRow) => r.kind === 'operation' && r.tool === tool;

/** Why a message the project's rooms hold is no post of this caller's, or null where it is. */
function notYours(actor: Actor, messageId: string, post: ActionRow): Outcome<never> | null {
  const input = (post.input ?? {}) as PostInput;
  const madeFor = typeof input.for === 'string' ? input.for : post.projectId;
  if (madeFor !== actor.projectId) {
    return no(
      'SUPPORT_POST_NOT_YOURS',
      '/messageId',
      `message ${messageId} is another project's master post; a master edits or deletes only its own. ${NOTHING}`,
    );
  }
  if (input.by !== actor.userId) {
    return no(
      'SUPPORT_POST_NOT_YOURS',
      '/messageId',
      `message ${messageId} was posted through master-posts by another account; a master edits or deletes only the posts it made. ${NOTHING}`,
    );
  }
  return null;
}

/** The caller's own post named by `messageId`, within its window, or the refusal naming why not. */
async function ownPost(actor: Actor, messageId: string): Promise<Outcome<OwnPost>> {
  const records = await recordsOf(messageId);
  const post = records.find(isPost);
  if (!post) {
    const held = records.find((r) => r.projectId === actor.projectId);
    if (held) {
      return no(
        'SUPPORT_POST_NOT_YOURS',
        '/messageId',
        `message ${messageId} is a ${held.kind} in this project's room, not a post made through master-posts; only those are edited or deleted here. ${NOTHING}`,
      );
    }
    return no(
      'SUPPORT_POST_UNKNOWN',
      '/messageId',
      `no post made through master-posts is message ${messageId}: name the messageId its post answered. ${NOTHING}`,
    );
  }
  const theirs = notYours(actor, messageId, post);
  if (theirs) return theirs;
  const deleted = records.find(isAct(DELETE_TOOL));
  if (deleted) {
    return no(
      'SUPPORT_POST_DELETED',
      '/messageId',
      `message ${messageId} was deleted at ${deleted.createdAt.toISOString()}. ${NOTHING}`,
    );
  }
  if (Date.now() - post.createdAt.getTime() > SUPPORT_MASTER_POST_EDIT_WINDOW_MS) {
    return no(
      'SUPPORT_POST_EDIT_WINDOW_PASSED',
      '/messageId',
      `message ${messageId} was posted at ${post.createdAt.toISOString()}, and a master edits or deletes its post only within ${WINDOW_MINUTES} minutes of posting: post a correction as a new message instead. ${NOTHING}`,
    );
  }
  const room = await roomById(post.roomId);
  if (!room || !(await roomIsBound(room))) {
    return no(
      'SUPPORT_ROOM_SWITCHED_OFF',
      '/messageId',
      `the room message ${messageId} was posted in is answered by no binding of this project now, so its bot changes nothing there. ${NOTHING}`,
    );
  }
  const input = (post.input ?? {}) as PostInput;
  const edited = records.filter(isAct(EDIT_TOOL)).at(-1)?.input as PostInput | undefined;
  const text = [edited?.text, input.text].find((t): t is string => typeof t === 'string') ?? '';
  const files = Array.isArray(input.attachments)
    ? input.attachments.flatMap((a: { messageId?: unknown }) =>
        typeof a.messageId === 'string' ? [a.messageId] : [],
      )
    : [];
  return {
    ok: true,
    value: { post, room, team: (await readersOf(room)) === 'team', text, files },
  };
}

/** The record of an edit or a delete: who, which message, on the post's own room and thread. */
async function recordAct(
  actor: Actor,
  own: OwnPost,
  tool: string,
  messageId: string,
  input: Record<string, unknown>,
): Promise<Date> {
  const row = await insertAction({
    roomId: own.room.id,
    projectId: own.room.projectId,
    conversationId: own.post.conversationId,
    thread: own.post.thread,
    kind: 'operation',
    actorKind: 'session',
    tool,
    input: {
      messageId,
      by: actor.userId,
      ...(own.room.projectId === actor.projectId ? {} : { for: actor.projectId }),
      ...input,
    },
    externalId: messageId,
  });
  return row?.createdAt ?? new Date();
}

const unchanged = (messageId: string, room: RoomRow, act: string, why: string): Outcome<never> =>
  no(
    'SUPPORT_POST_UNCHANGED',
    '/messageId',
    `the chat server would not ${act} message ${messageId} in ${room.rid}: ${why}. ${NOTHING}`,
  );

type Edited = { rid: string; messageId: string; thread: string; text: string; editedAt: string };

/** Replace the text of the caller's own post, screened for the room's readers as the post was. */
export async function editMasterPost(
  actor: Actor,
  messageId: string,
  given: string,
): Promise<Outcome<Edited>> {
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(actor.projectId));
  const own = await ownPost(actor, messageId);
  if (!own.ok) return own;
  const { post, room, team } = own.value;
  const text = await scrubbedForRoom(room, given);
  // a post in a named thread was screened in it; one naming none, as the top level is (`postAtTop`)
  const top = post.kind === 'announced';
  if (!top && !team) {
    const asker = (await askerOf(room, post.thread)).username;
    const mentions = await mentionRefusal<never>(room, text, asker, post.thread);
    if (mentions) return mentions;
  }
  const admitted = await screenForThread(
    room,
    top ? null : post.conversationId,
    top ? TOP_LEVEL : post.thread,
    text,
    team ? 'operations-reply' : 'support-reply',
    TOOL,
  );
  if (!admitted.ok) return admitted;
  const { auth } = await roomAuth(room);
  const out = await editProvenReply(
    auth,
    room.rid,
    messageId,
    admitted.value.text,
    admitted.value.proof,
  );
  if (!out.ok) return unchanged(messageId, room, 'edit', out.why);
  const at = await recordAct(actor, own.value, EDIT_TOOL, messageId, {
    before: own.value.text,
    text,
  });
  return {
    ok: true,
    value: { rid: room.rid, messageId, thread: post.thread, text, editedAt: at.toISOString() },
  };
}

type Deleted = { rid: string; messageId: string; thread: string; deleted: string[]; at: string };

/** Delete the caller's own post, and the messages its images or PDF went out as. */
export async function deleteMasterPost(actor: Actor, messageId: string): Promise<Outcome<Deleted>> {
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(actor.projectId));
  const own = await ownPost(actor, messageId);
  if (!own.ok) return own;
  const { post, room } = own.value;
  const { auth } = await roomAuth(room);
  const first = await deleteRoomMessage(auth, room.rid, messageId);
  if (!first.ok) return unchanged(messageId, room, 'delete', first.why);
  const deleted = [messageId];
  const left: string[] = [];
  for (const file of own.value.files) {
    const out = await deleteRoomMessage(auth, room.rid, file);
    if (out.ok) deleted.push(file);
    else left.push(`${file} (${out.why})`);
  }
  const at = await recordAct(actor, own.value, DELETE_TOOL, messageId, {
    text: own.value.text,
    deleted,
    ...(left.length > 0 ? { left } : {}),
  });
  if (left.length > 0) {
    return no(
      'SUPPORT_POST_UNCHANGED',
      '/messageId',
      `message ${messageId} was deleted from ${room.rid}, but the chat server would not delete its file messages ${left.join(', ')}: they stay in the room.`,
    );
  }
  return {
    ok: true,
    value: { rid: room.rid, messageId, thread: post.thread, deleted, at: at.toISOString() },
  };
}

const postParam = zValidator(
  'param',
  z.object({
    id: z.uuid(),
    messageId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
  }),
  invalid('invalid path: a project uuid and the chat message id a master post answered'),
);

/** `PATCH` and `DELETE /:id/support/master-posts/:messageId`: a master's own post, within its window. */
export function mountMasterPostEditRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.patch(
    '/:id/support/master-posts/:messageId',
    postParam,
    requiresOnParam('project.write', 'id'),
    strictBody(supportMasterPostEditRequestSchema, '{ text }'),
    async (c) => {
      const { id, messageId } = c.req.valid('param');
      const out = await editMasterPost(
        { userId: c.get('userId'), projectId: id },
        messageId,
        c.req.valid('json').text,
      );
      if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
      return c.json(out.value);
    },
  );
  routes.delete(
    '/:id/support/master-posts/:messageId',
    postParam,
    requiresOnParam('project.write', 'id'),
    noQuery,
    async (c) => {
      const { id, messageId } = c.req.valid('param');
      const out = await deleteMasterPost({ userId: c.get('userId'), projectId: id }, messageId);
      if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
      return c.json(out.value);
    },
  );
}
