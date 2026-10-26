// Recording what needs code as Feedback for the team (REQ-75 BC-14), then following it (BC-15).

import { createHash } from 'node:crypto';
import { FEEDBACK_LIMITS } from '@forge/contracts/feedback';
import type { SupportRecordKind } from '@forge/contracts/support';
import { type ExternalReporter, fileExternalFeedback } from '../feedback/index.js';
import { buildMessagePermalink } from '../integrations/rocketchat/index.js';
import { mintStatusToken } from '../widget/index.js';
import { knownThread, type Outcome, threadUnknown } from './outcome.js';
import { refusalOf } from './refusals.js';
import { FEEDBACK_KIND_OF, visitorIdOf } from './rules.js';
import { insertAction, insertLink, type RoomRow, threadMembers } from './store.js';
import { postInThread, roomAuth, scrubbedForRoom } from './thread.js';

/**
 * Record what needs code as Feedback for the team (BC-14): filed as the room's own account through
 * the external filing door, the thread's first writer as its reporter, the thread's link in its
 * body; the thread is told the key and is followed until it ships (BC-15). The external filing
 * door takes a status token, minted and never posted: in a group anyone could open it, and the
 * thread's own progress lines are the status.
 */
export async function record(
  room: RoomRow,
  input: {
    thread: string;
    kind: SupportRecordKind;
    title: string;
    summary: string;
    whereSeen?: string | undefined;
  },
): Promise<Outcome<{ feedbackKey: string; created: boolean }>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const [reporter] = await threadMembers(room.id, input.thread);
  if (!reporter) return threadUnknown(input.thread);
  const { auth, namespace } = await roomAuth(room);
  const permalink = await buildMessagePermalink(auth, room.rid, input.thread).catch(() => null);
  const status = mintStatusToken();
  const external: ExternalReporter = {
    channel: 'rocketchat',
    bindingId: room.bindingId,
    visitorId: visitorIdOf(namespace, reporter.key),
    email: null,
    name: reporter.label,
    signedUserId: reporter.key,
    pageContext: { thread: input.thread, ...(permalink ? { threadUrl: permalink } : {}) },
    statusTokenHash: status.hash,
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
      text: `Recorded as ${filed.key} for the team. I will post its progress in this thread.`,
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
