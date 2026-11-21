// The shots a room agent's reply posts after its text (ISS-1386): the `picture` of a look the room
// took in the same thread, so the person sees what the agent saw. A picture of a signed-in screen can
// show a person's data, so a reply names only a look of its own room and thread; any other id is
// refused by name, and every shot is checked and staged on the chat server before the text goes out,
// as a master's post's images are (`master-post-images.ts`).

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import {
  checkPostImages,
  type PostedImage,
  postImagesAfter,
  type StagedImages,
  stagePostImages,
} from './master-post-images.js';
import type { Outcome } from './outcome.js';
import { refusalOf } from './refusals.js';
import type { RoomRow } from './store.js';

/** The pictures among `shots` a look of `room` took in `thread`. */
async function lookPictures(room: RoomRow, thread: string, shots: readonly string[]) {
  const picture = sql<string>`${supportActions.output}->>'picture'`;
  const rows = await db
    .select({ picture })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.thread, thread),
        eq(supportActions.tool, 'look'),
        inArray(picture, [...shots]),
      ),
    );
  return new Set(rows.map((r) => r.picture));
}

const atShots = <T>(out: Outcome<T>): Outcome<T> =>
  out.ok
    ? out
    : {
        ...out,
        refusals: out.refusals.map((r) => ({
          ...r,
          path: r.path.replace(/^\/attachments/, '/shots'),
        })),
      };

/** Every shot checked and staged unposted, or every refusal; nothing is posted either way. */
export async function stageReplyShots(
  room: RoomRow,
  thread: string,
  shots: readonly string[] | undefined,
): Promise<Outcome<StagedImages>> {
  if (!shots?.length) return { ok: true, value: { images: [], fileIds: [] } };
  const taken = await lookPictures(room, thread, shots);
  const unknown = shots.flatMap((id, i) =>
    taken.has(id)
      ? []
      : [
          refusalOf(
            'SUPPORT_REPLY_SHOT_UNKNOWN',
            `/shots/${i}`,
            `${id} is no picture a look of this room took in thread ${thread}: name the \`picture\` a support.look in this thread answered. Nothing was posted`,
          ),
        ],
  );
  if (unknown.length > 0) return { ok: false, refusals: unknown };
  const images = await checkPostImages(
    room.principalUserId,
    room.projectId,
    shots.map((attachmentId) => ({ target: 'session' as const, attachmentId })),
  );
  if (!images.ok) return atShots(images);
  return atShots(await stagePostImages(room, images.value));
}

/** Post the staged shots after the reply's text, in its thread. */
export async function postReplyShots(
  room: RoomRow,
  staged: StagedImages,
  thread: string,
  messageId: string | null,
): Promise<{ posted: PostedImage[]; failure: Outcome<never> | null }> {
  const out = await postImagesAfter(room, staged, thread, messageId);
  return { ...out, failure: out.failure ? atShots(out.failure) : null };
}
