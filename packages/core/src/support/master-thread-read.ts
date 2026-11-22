// A master reads a users' thread before it posts there (ISS-1406, owner 2026-11-22: "check first;
// answer only the right matter at the right time"). In Forge-Feedback a master posted ten seconds
// after the room agent and contradicted it, and two more masters posted on matters the thread was
// not about: none of them could see what the thread had just been told. This door shows the
// thread's recent posts (who, when, what) in any room the master's post reaches (`masterReach`),
// across every binding's record of the group, each text screened as a master's post is.

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { LAST_RESORT_LINES, STILL_QUEUED_LINE } from '../conversations/index.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { forgeReads } from '../integrations/index.js';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan, requiresOnParam } from '../permissions/index.js';
import {
  isShared,
  masterReach,
  roomOfThread,
  roomRecording,
  roomRefusal,
  TOOL,
} from './master-post.js';
import type { Outcome } from './outcome.js';
import { type RoomRow, roomsOnRid } from './store.js';
import { scrubbedForRoom } from './thread.js';

/** How many of the thread's newest posts are shown. */
const POSTS_SHOWN = 20;
/** How many of the thread's records are read to find them: each member line is one per binding. */
const RECORDS_READ = 120;

/** Core's own lines in a support thread, by the tool their record names (`last-resort.ts`). */
const CORE_LINES: Readonly<Record<string, string>> = {
  offline: LAST_RESORT_LINES.offline,
  turn_failed: STILL_QUEUED_LINE,
  rate_limited: LAST_RESORT_LINES.rate_limited,
};

/** One post of the thread as a master reads it. */
export interface ThreadPost {
  /** `member`, the room `agent`, a project's `master`, or `core`'s own line. */
  by: 'member' | 'agent' | 'master' | 'core';
  /** The member's name, as the chat server gave it. */
  name?: string;
  /** The project whose agent or master posted it, by slug. */
  project?: string;
  at: string;
  text: string;
}

export interface MasterThreadRead {
  rid: string;
  thread: string;
  /** Who reads the room: its `users`, or the `team`. */
  readers: 'users' | 'team';
  /** Oldest first; a bot post a later one replaced in place shows as the one that stands. */
  posts: ThreadPost[];
}

type Row = {
  roomProject: string;
  kind: string;
  tool: string | null;
  actorKind: string;
  label: string | null;
  input: unknown;
  output: unknown;
  externalId: string | null;
  at: Date;
};

const field = (v: unknown, key: string): unknown =>
  v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
const textOf = (v: unknown): string | null => {
  const t = field(v, 'text');
  return typeof t === 'string' ? t : null;
};

/** What one record says was posted in the thread, or null where it posted nothing there. */
function postOf(row: Row): (Omit<ThreadPost, 'project'> & { projectId?: string }) | null {
  const at = row.at.toISOString();
  if (row.kind === 'message_in' && row.actorKind === 'member') {
    const text = textOf(row.input);
    return text === null ? null : { by: 'member', name: row.label ?? 'member', at, text };
  }
  if (row.kind === 'reply' && row.actorKind === 'session') {
    const text = textOf(row.input);
    return text === null ? null : { by: 'agent', projectId: row.roomProject, at, text };
  }
  if ((row.kind === 'routed' || row.kind === 'announced') && row.tool === TOOL) {
    const text = textOf(row.input);
    const forId = field(row.input, 'for');
    const projectId = typeof forId === 'string' ? forId : row.roomProject;
    return text === null ? null : { by: 'master', projectId, at, text };
  }
  const line = row.tool ? CORE_LINES[row.tool] : undefined;
  if (row.kind === 'refused' && row.actorKind === 'core' && line) {
    return field(row.output, 'posted') === true ? { by: 'core', at, text: line } : null;
  }
  return null;
}

/** The thread's newest posts on every binding's record of the group, oldest first. */
async function threadPosts(room: RoomRow, thread: string): Promise<ThreadPost[]> {
  const holders = await roomsOnRid(room.rid);
  const rooms = holders.some((r) => r.id === room.id) ? holders : [room, ...holders];
  const projectOf = new Map(rooms.map((r) => [r.id, r.projectId]));
  const records = await db
    .select({
      roomId: supportActions.roomId,
      kind: supportActions.kind,
      tool: supportActions.tool,
      actorKind: supportActions.actorKind,
      label: supportActions.actorLabel,
      input: supportActions.input,
      output: supportActions.output,
      externalId: supportActions.externalId,
      at: supportActions.createdAt,
    })
    .from(supportActions)
    .where(
      and(
        inArray(
          supportActions.roomId,
          rooms.map((r) => r.id),
        ),
        eq(supportActions.thread, thread),
        inArray(supportActions.kind, ['message_in', 'reply', 'routed', 'announced', 'refused']),
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(RECORDS_READ);
  // oldest first; a post with a message id already shown is the same message: a member line each
  // binding recorded, or a bot post a later one replaced in place (`one-voice.ts`)
  const byMessage = new Map<string, number>();
  const posts: (Omit<ThreadPost, 'project'> & { projectId?: string })[] = [];
  for (const r of records.reverse()) {
    const post = postOf({ ...r, roomProject: projectOf.get(r.roomId) ?? room.projectId });
    if (!post) continue;
    const held = r.externalId ? byMessage.get(r.externalId) : undefined;
    if (held !== undefined) {
      if (post.by !== 'member') posts[held] = { ...post, at: posts[held]?.at ?? post.at };
      continue;
    }
    if (r.externalId) byMessage.set(r.externalId, posts.length);
    posts.push(post);
  }
  const shown = posts.slice(-POSTS_SHOWN);
  const ids = [...new Set(shown.flatMap((p) => (p.projectId ? [p.projectId] : [])))];
  const projects = ids.length ? await forgeReads().projectsByIds(ids) : [];
  const slugOf = (id: string) => projects.find((p) => p.id === id)?.slug ?? id;
  return Promise.all(
    shown.map(async ({ projectId, ...p }) => ({
      ...p,
      ...(projectId ? { project: slugOf(projectId) } : {}),
      // screened as a master's post is: the room's secrets and every pattern the scrubber knows
      text: await scrubbedForRoom(room, p.text),
    })),
  );
}

/**
 * A users' or team thread's recent posts, read by the project's master before it posts there: in
 * any room its post reaches, its project's own thread of a shared operations room, never another
 * project's thread there; refused by name where the post would be.
 */
export async function readThreadAsMaster(
  actor: { userId: string; projectId: string },
  input: { thread: string; rid?: string | undefined },
): Promise<Outcome<MasterThreadRead>> {
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(actor.projectId));
  const { rooms, followed } = await masterReach(actor.projectId, input.rid);
  const nothing = 'Nothing was read.';
  if (input.rid && !rooms.some((r) => r.room.rid === input.rid)) {
    return roomRefusal(actor.projectId, input.rid, rooms, nothing);
  }
  const recording = await roomRecording(actor.projectId, rooms, input.rid, input.thread);
  let at = recording;
  if (!at) {
    // another project's shared operations room shows this project's own thread alone (ISS-1242)
    const open = rooms.filter((r) => !(followed.includes(r) && isShared(r.room)));
    const found = await roomOfThread(open, input.rid, input.thread, nothing);
    if (!found.ok) return found;
    at = found.value.at;
  }
  return {
    ok: true,
    value: {
      rid: at.room.rid,
      thread: input.thread,
      readers: at.team ? 'team' : 'users',
      posts: await threadPosts(at.room, input.thread),
    },
  };
}

const CHAT_ID = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

const threadParam = zValidator(
  'param',
  z.object({ id: z.uuid(), thread: CHAT_ID }),
  invalid('invalid path: a project uuid and the chat message id that opens the thread'),
);

const threadQuery = zValidator(
  'query',
  z.strictObject({ rid: CHAT_ID.optional() }),
  invalid('invalid query: { rid?: the room the thread is in }'),
);

/** `GET /:id/support/master-posts/threads/:thread`: the thread's recent posts, read before a post. */
export function mountMasterThreadRoute(routes: Hono<{ Variables: AuthVars }>): void {
  routes.get(
    '/:id/support/master-posts/threads/:thread',
    threadParam,
    requiresOnParam('project.write', 'id'),
    threadQuery,
    async (c) => {
      const { id, thread } = c.req.valid('param');
      const out = await readThreadAsMaster(
        { userId: c.get('userId'), projectId: id },
        { thread, rid: c.req.valid('query').rid },
      );
      if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
      return c.json(out.value);
    },
  );
}
