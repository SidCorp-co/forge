// The images a master's post carries (ISS-1024): uploads Forge already stores on an issue, a comment
// or an agent session, read through the uploads module's own lookup, so the caller names an upload by
// the id every attachment list shows and never hands over bytes. Every image is checked and read
// before anything is posted, and staged on the chat server before the text goes out, so a refusal
// leaves the room untouched. Each one then posts after the text, as its own message in the text's
// thread (or the text's top level), with the bot credential core holds and under a neutral name: an
// upload's own name is the uploader's words and is never screened for the room's readers.

import { ROOM_IMAGE_CAPS, ROOM_IMAGE_MIMES } from '@forge/contracts/support';
import type { SupportMasterPostAttachment } from '@forge/contracts/support-channel';
import { postStagedMedia, stageRoomMedia } from '../integrations/rocketchat/index.js';
import { RefusalError } from '../lib/refusal.js';
import { actorFor, can, projectResource } from '../permissions/index.js';
import { loadAttachment, readAttachmentBytes } from '../uploads/index.js';
import { no, type Outcome } from './outcome.js';
import { type Refusal, refusalOf } from './refusals.js';
import type { RoomRow } from './store.js';
import { roomAuth } from './thread.js';

/** One image checked for a post: what the record names, and the bytes the chat server is sent. */
export interface PostImage {
  target: SupportMasterPostAttachment['target'];
  attachmentId: string;
  name: string;
  mime: string;
  size: number;
  bytes: Buffer;
}

/** What a post's record names of an image: the upload and where it went, never its bytes. */
export interface PostedImage {
  target: SupportMasterPostAttachment['target'];
  attachmentId: string;
  name: string;
  mime: string;
  size: number;
  messageId: string | null;
}

const IMAGE_MIMES: ReadonlySet<string> = new Set(ROOM_IMAGE_MIMES);
const MIME_EXT: Record<(typeof ROOM_IMAGE_MIMES)[number], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const VALID = `an issue, comment or session upload of this project, a ${ROOM_IMAGE_MIMES.join(', ')} of at most ${ROOM_IMAGE_CAPS.bytes} bytes`;

/** One item checked: the image, or why it cannot go into a room. */
async function checkOne(
  userId: string,
  projectId: string,
  item: SupportMasterPostAttachment,
  at: string,
): Promise<PostImage | Refusal> {
  const named = `${item.target} upload ${item.attachmentId}`;
  const att = await loadAttachment(item.target, item.attachmentId);
  if (!att) {
    return refusalOf('SUPPORT_POST_IMAGE_UNKNOWN', at, `no ${named} exists; name ${VALID}`);
  }
  // A room is read by the posting project's people alone, so an upload of another project, however
  // readable to the caller, would carry that project's file to readers who were never let in.
  if (att.projectId !== projectId) {
    return refusalOf(
      'SUPPORT_POST_IMAGE_UNREADABLE',
      at,
      `${named} belongs to another project, and this room is read by this project's people; name ${VALID}`,
    );
  }
  if (!(await can(actorFor(userId), 'project.read', projectResource(att.projectId)))) {
    return refusalOf(
      'SUPPORT_POST_IMAGE_UNREADABLE',
      at,
      `${named} belongs to a project you cannot read; name ${VALID}`,
    );
  }
  if (!IMAGE_MIMES.has(att.mime)) {
    return refusalOf(
      'SUPPORT_POST_IMAGE_NOT_AN_IMAGE',
      at,
      `${named} is ${att.mime}, not an image a room shows; name ${VALID}`,
    );
  }
  if (att.size > ROOM_IMAGE_CAPS.bytes) {
    return refusalOf(
      'SUPPORT_POST_IMAGE_TOO_LARGE',
      at,
      `${named} is ${att.size} bytes, over the ${ROOM_IMAGE_CAPS.bytes} a room's picture holds; name ${VALID}`,
    );
  }
  try {
    const bytes = await readAttachmentBytes(att);
    return { ...item, name: att.name, mime: att.mime, size: bytes.byteLength, bytes };
  } catch (err) {
    if (!(err instanceof RefusalError)) throw err;
    return refusalOf(
      'SUPPORT_POST_IMAGE_FILE_MISSING',
      at,
      `the file of ${named} is missing from storage; attach it again and name the new upload`,
    );
  }
}

/** Every item of a post checked and read, or every item's refusal; nothing is posted either way. */
export async function checkPostImages(
  userId: string,
  projectId: string,
  items: readonly SupportMasterPostAttachment[] | undefined,
): Promise<Outcome<PostImage[]>> {
  if (!items?.length) return { ok: true, value: [] };
  const checked = await Promise.all(
    items.map((item, i) => checkOne(userId, projectId, item, `/attachments/${i}`)),
  );
  const refusals = checked.filter((c): c is Refusal => 'code' in c);
  if (refusals.length > 0) {
    return {
      ok: false,
      refusals: refusals.map((r) => ({ ...r, detail: `${r.detail}. Nothing was posted.` })),
    };
  }
  return { ok: true, value: checked as PostImage[] };
}

/** Images on the chat server, not yet posted. */
export interface StagedImages {
  images: readonly PostImage[];
  fileIds: string[];
}

const unposted = <T>(path: string, detail: string): Outcome<T> =>
  no('SUPPORT_POST_IMAGE_UNPOSTED', path, detail);

/** Upload every image into the room unposted, before any line goes out; the first the server refuses ends it. */
export async function stagePostImages(
  room: RoomRow,
  images: readonly PostImage[],
): Promise<Outcome<StagedImages>> {
  if (images.length === 0) return { ok: true, value: { images, fileIds: [] } };
  const { auth } = await roomAuth(room);
  const fileIds: string[] = [];
  for (const [i, image] of images.entries()) {
    const name = `image-${i + 1}.${MIME_EXT[image.mime as keyof typeof MIME_EXT]}`;
    const staged = await stageRoomMedia(auth, room.rid, {
      bytes: image.bytes,
      mime: image.mime,
      name,
    });
    if (!staged.ok) {
      return unposted(
        `/attachments/${i}`,
        `the chat server took no upload of ${image.target} upload ${image.attachmentId} into ${room.rid}: ${staged.why}. Nothing was posted.`,
      );
    }
    fileIds.push(staged.fileId);
  }
  return { ok: true, value: { images, fileIds } };
}

/**
 * Post the staged images after the text, each in `thread` (null: the room's top level, as the text).
 * Answers what went out; an image the server will not post after the text did is refused naming the
 * text's message and what did go, so the caller knows what the room shows.
 */
export async function postImagesAfter(
  room: RoomRow,
  staged: StagedImages,
  thread: string | null,
  textMessageId: string | null,
): Promise<{ posted: PostedImage[]; failure: Outcome<never> | null }> {
  if (staged.images.length === 0) return { posted: [], failure: null };
  const { auth } = await roomAuth(room);
  const posted: PostedImage[] = [];
  for (const [i, image] of staged.images.entries()) {
    const fileId = staged.fileIds[i] as string;
    const out = await postStagedMedia(auth, room.rid, fileId, thread ?? undefined);
    if (!out.ok) {
      const went = posted.map((p) => p.attachmentId).join(', ') || 'none';
      return {
        posted,
        failure: unposted(
          `/attachments/${i}`,
          `the text was posted as message ${textMessageId ?? '(no id)'} in ${room.rid}, but the chat server would not post ${image.target} upload ${image.attachmentId} after it: ${out.why}. Images posted: ${went}.`,
        ),
      };
    }
    const { bytes: _bytes, ...named } = image;
    posted.push({ ...named, messageId: out.messageId });
  }
  return { posted, failure: null };
}
