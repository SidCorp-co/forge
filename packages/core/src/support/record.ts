// Filing what needs code as Feedback for the team once its asker agreed (REQ-75 BC-14), then telling
// the session its result once it is final (r6 BC-15, `result.ts`). Core posts nothing: the session
// is handed the key and tells the person in its own words (ISS-845).

import { createHash } from 'node:crypto';
import { FEEDBACK_LIMITS } from '@forge/contracts/feedback';
import type { SupportRecordKind } from '@forge/contracts/support';
import { attachToFiled, type ExternalReporter, fileExternalFeedback } from '../feedback/index.js';
import { buildMessagePermalink } from '../integrations/rocketchat/index.js';
import { fetchRecordedImage, threadImages } from './images.js';
import { namedProject } from './ops-scope.js';
import { knownThread, type Outcome, threadUnknown } from './outcome.js';
import { refusalOf } from './refusals.js';
import { FEEDBACK_KIND_OF, visitorIdOf } from './rules.js';
import { insertAction, insertLink, type RoomRow } from './store.js';
import { roomAuth, scrubbedForRoom } from './thread.js';

/** What the session asks to file: the route (kind), a title, and the need in plain words. */
export interface RecordRequest {
  thread: string;
  kind: SupportRecordKind;
  title: string;
  summary: string;
  whereSeen?: string | undefined;
  /** The project whose master it is for: one the channel agent follows; the home project when omitted (ISS-874). */
  project?: string | undefined;
}

/** The thread's link in Rocket.Chat, or the room and thread ids where the server gives none. */
export async function threadLink(room: RoomRow, thread: string): Promise<string> {
  const { auth } = await roomAuth(room);
  const permalink = await buildMessagePermalink(auth, room.rid, thread).catch(() => null);
  return permalink ?? `${room.rid} / ${thread}`;
}

/**
 * File what needs code as Feedback for the team (BC-14), once the asker agreed
 * (`fixes.ts:agreeTo`): filed as the room's own account through the external filing door, the asker
 * as its reporter, the thread's link in its body. The key goes back to the session, which tells the
 * thread; its result follows once it is final (r6 BC-15). The external filing door hands a group
 * member no status link: in a group anyone could open it.
 */
export async function fileRecord(
  room: RoomRow,
  input: RecordRequest & { reporter: { key: string; label: string | null } },
): Promise<
  Outcome<{ feedbackKey: string; created: boolean; project: string; pictures?: FiledPictures }>
> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  // the project it names is read again at filing: one dropped from the set since is refused, never
  // filed to the home project instead (ISS-874)
  const target = await namedProject(room, input.project);
  if (!target.ok) return target;
  const projectId = target.value.id;
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
    projectId,
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
            // the item's project, whose phases the result follow-up reads (`result.ts`)
            projectId,
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
  // the thread's pictures go with what was filed from it, readable with uploads.read (ISS-1010)
  const pictures = filed.created ? await attachThreadPictures(room, input.thread, filed.id) : null;
  if (filed.created) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: input.thread,
      kind: 'feedback_recorded',
      actorKind: 'session',
      input: { kind: input.kind, title: input.title, project: target.value.slug },
      output: { feedbackKey: filed.key, ...(pictures ? { pictures } : {}) },
      feedbackId: filed.id,
    });
  }
  return {
    ok: true,
    value: {
      feedbackKey: filed.key,
      created: filed.created,
      project: target.value.slug,
      ...(pictures ? { pictures } : {}),
    },
  };
}

/** What became of a thread's pictures on the item filed from it: how many went, and each that did not, with why. */
export interface FiledPictures {
  attached: number;
  notAttached: { message: string; n: number; code: string; why: string }[];
}

/**
 * Attach every picture the members' messages of the thread recorded to the item filed from it, up
 * to the most one item keeps (ISS-1010): each fetched with the room's bot credential, as the session
 * reads it, and stored as every feedback attachment is. One that cannot be fetched or kept is named
 * with why; the filing stands either way. Null where the thread carried no picture.
 */
async function attachThreadPictures(
  room: RoomRow,
  thread: string,
  itemId: string,
): Promise<FiledPictures | null> {
  const all = await threadImages(room.id, thread);
  if (all.length === 0) return null;
  const notAttached: FiledPictures['notAttached'] = [];
  const kept = all.slice(0, FEEDBACK_LIMITS.attachmentsPerItem);
  for (const p of all.slice(FEEDBACK_LIMITS.attachmentsPerItem)) {
    notAttached.push({
      message: p.message,
      n: p.n,
      code: 'FEEDBACK_ATTACHMENTS_FULL',
      why: `an item keeps at most ${FEEDBACK_LIMITS.attachmentsPerItem} attachments`,
    });
  }
  const files: { name: string; mime: string; contentBase64: string }[] = [];
  const sources: { message: string; n: number }[] = [];
  for (const p of kept) {
    const got = await fetchRecordedImage(room, p.image);
    if (!got.ok) {
      notAttached.push({ message: p.message, n: p.n, code: got.code, why: got.why });
      continue;
    }
    files.push({
      name: p.image.name,
      mime: p.image.mime,
      contentBase64: got.bytes.toString('base64'),
    });
    sources.push({ message: p.message, n: p.n });
  }
  const put = await attachToFiled({
    projectId: room.projectId,
    itemId,
    uploadedBy: room.principalUserId,
    files,
  });
  for (const { file, refusal } of put.refused) {
    // `files` and `sources` are built side by side, so each refused file has its source
    const source = sources[file] as { message: string; n: number };
    notAttached.push({ ...source, code: refusal.code, why: refusal.detail });
  }
  return { attached: put.attached.length, notAttached };
}
