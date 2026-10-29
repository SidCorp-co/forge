// Filing what needs code as Feedback for the team once its asker confirmed it (REQ-75 BC-14), then
// telling its result once it is final (r6 BC-15, `result.ts`).

import { createHash } from 'node:crypto';
import { FEEDBACK_LIMITS } from '@forge/contracts/feedback';
import type { SupportRecordKind } from '@forge/contracts/support';
import { type ExternalReporter, fileExternalFeedback } from '../feedback/index.js';
import { buildMessagePermalink } from '../integrations/rocketchat/index.js';
import { knownThread, type Outcome, threadUnknown } from './outcome.js';
import { refusalOf } from './refusals.js';
import { FEEDBACK_KIND_OF, visitorIdOf } from './rules.js';
import { insertAction, insertLink, type RoomRow } from './store.js';
import { postInThread, roomAuth, scrubbedForRoom } from './thread.js';

/** What the session asks to file: the route (kind), a title, and the need in plain words. */
export interface RecordRequest {
  thread: string;
  kind: SupportRecordKind;
  title: string;
  summary: string;
  whereSeen?: string | undefined;
}

/** The thread's link in Rocket.Chat, or the room and thread ids where the server gives none. */
export async function threadLink(room: RoomRow, thread: string): Promise<string> {
  const { auth } = await roomAuth(room);
  const permalink = await buildMessagePermalink(auth, room.rid, thread).catch(() => null);
  return permalink ?? `${room.rid} / ${thread}`;
}

/**
 * File what needs code as Feedback for the team (BC-14), once the asker confirmed it
 * (`fixes.ts:proposeRecord`): filed as the room's own account through the external filing door,
 * the asker as its reporter, the thread's link in its body; the thread is told the key, and its
 * result once it is final (r6 BC-15). The external filing door hands a group member no status link:
 * in a group anyone could open it, and the result posted in the thread is what they are owed.
 */
export async function fileRecord(
  room: RoomRow,
  input: RecordRequest & { reporter: { key: string; label: string | null } },
): Promise<Outcome<{ feedbackKey: string; created: boolean }>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const { reporter } = input;
  const { auth, namespace } = await roomAuth(room);
  const permalink = await buildMessagePermalink(auth, room.rid, input.thread).catch(() => null);
  const external: ExternalReporter = {
    channel: 'rocketchat',
    bindingId: room.bindingId,
    visitorId: visitorIdOf(namespace, reporter.key),
    email: null,
    name: reporter.label,
    signedUserId: reporter.key,
    pageContext: { thread: input.thread, ...(permalink ? { threadUrl: permalink } : {}) },
    statusTokenHash: null,
  };
  const body = await scrubbedForRoom(
    room,
    [
      input.summary,
      '',
      `Reported in the Rocket.Chat support group by ${reporter.label ?? reporter.key}.`,
      `Thread: ${permalink ?? `${room.rid} / ${input.thread}`}`,
    ].join('\n'),
  );
  const screen = (input.whereSeen ?? 'Rocket.Chat support group')
    .slice(0, FEEDBACK_LIMITS.whereSeen)
    .trim();
  const titleDigest = createHash('sha256')
    .update(input.title.trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
  const filed = await fileExternalFeedback({
    projectId: room.projectId,
    filedAs: room.principalUserId,
    request: {
      kind: FEEDBACK_KIND_OF[input.kind],
      title: input.title,
      body,
      screen,
    },
    reporter: external,
    dedupKey: `support:${room.id}:${input.thread}:${titleDigest}`,
    within: {
      after: async (tx, item) => {
        await insertLink(
          {
            feedbackId: item.id,
            roomId: room.id,
            projectId: room.projectId,
            thread: input.thread,
            lastPhase: 'new',
          },
          tx,
        );
      },
    },
  });
  if (!filed.ok) {
    return {
      ok: false,
      refusals: filed.refusals.map((r) =>
        refusalOf('SUPPORT_REFUSED', r.path, `${r.code}: ${r.detail}`),
      ),
    };
  }
  if (filed.created) {
    const posted = await postInThread({
      room,
      thread: input.thread,
      text: `Recorded as ${filed.key} for the team. I will post the result here once it is live.`,
    });
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: posted.conversationId,
      thread: input.thread,
      kind: 'feedback_recorded',
      actorKind: 'session',
      input: { kind: input.kind, title: input.title },
      output: { feedbackKey: filed.key },
      externalId: posted.messageId,
      feedbackId: filed.id,
    });
  }
  return { ok: true, value: { feedbackKey: filed.key, created: filed.created } };
}
