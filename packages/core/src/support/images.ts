// The pictures a member's message carries (ISS-1010): recorded with the message as the chat server's
// refs, under the caps the chat-room Assistant reads under; read by the session through Forge, which
// fetches each with the room's bot credential, since the session's box has no route to the chat
// server; and attached to the Feedback the session files from the thread. A picture core cannot fetch
// is refused by name with why, never answered empty.

import type { SupportRefusalCode } from '@forge/contracts/support';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import {
  type AttachmentFetchFailure,
  fetchAttachment,
  ROCKETCHAT_IMAGE_CAPS,
  type RocketChatImageRef,
} from '../integrations/rocketchat/index.js';
import { no, type Outcome } from './outcome.js';
import type { RoomRow } from './store.js';
import { roomAuth } from './thread.js';

/** One picture as a `message_in` row's input records it: the chat server's ref, its name and type. */
export interface RecordedImage {
  name: string;
  mime: string;
  ref: string;
}

/** What a message's row records of its pictures: at most the cap, and how many past it were left. */
export function recordedImagesOf(images: readonly RocketChatImageRef[]): {
  images?: RecordedImage[];
  imagesOmitted?: number;
} {
  if (images.length === 0) return {};
  const kept = images
    .slice(0, ROCKETCHAT_IMAGE_CAPS.perMessage)
    .map(({ name, mime, ref }) => ({ name, mime, ref }));
  const omitted = images.length - kept.length;
  return { images: kept, ...(omitted > 0 ? { imagesOmitted: omitted } : {}) };
}

/** The pictures a row's input records, read defensively: a row written before ISS-1010 holds none. */
export function imagesOfInput(input: unknown): RecordedImage[] {
  const raw = (input as { images?: unknown } | null)?.images;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((i) => {
    const r = i as Partial<RecordedImage> | null;
    return typeof r?.ref === 'string' && typeof r.mime === 'string'
      ? [{ name: typeof r.name === 'string' ? r.name : 'image', mime: r.mime, ref: r.ref }]
      : [];
  });
}

/**
 * What the session is shown of a message's pictures, in the message's head: how many, their types,
 * and the act that reads them. A picture's name is the writer's and stays out of the head; the read
 * hands it framed as data.
 */
export function imagesHeadOf(input: unknown, messageId: string | null): Record<string, unknown> {
  const images = imagesOfInput(input);
  if (images.length === 0 || !messageId) return {};
  const omitted = (input as { imagesOmitted?: unknown }).imagesOmitted;
  return {
    images: {
      count: images.length,
      mimes: images.map((i) => i.mime),
      read: `support.image { message: "${messageId}", n } with n 1..${images.length}`,
      ...(typeof omitted === 'number' && omitted > 0 ? { omitted } : {}),
    },
  };
}

/** A member's message of this room and the pictures its row recorded. */
async function messageImages(
  roomId: string,
  messageId: string,
): Promise<{ thread: string; images: RecordedImage[] } | null> {
  const [row] = await db
    .select({ thread: supportActions.thread, input: supportActions.input })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
        eq(supportActions.externalId, messageId),
      ),
    )
    .limit(1);
  return row ? { thread: row.thread, images: imagesOfInput(row.input) } : null;
}

/** Every picture the members' messages of a thread recorded, oldest message first. */
export async function threadImages(
  roomId: string,
  thread: string,
): Promise<{ message: string; n: number; image: RecordedImage }[]> {
  const rows = await db
    .select({ externalId: supportActions.externalId, input: supportActions.input })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.thread, thread),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
      ),
    )
    .orderBy(asc(supportActions.createdAt));
  return rows.flatMap((r) =>
    r.externalId
      ? imagesOfInput(r.input).map((image, i) => ({
          message: r.externalId as string,
          n: i + 1,
          image,
        }))
      : [],
  );
}

const FAILURE: Record<AttachmentFetchFailure, { code: SupportRefusalCode; why: string }> = {
  off_server: {
    code: 'SUPPORT_IMAGE_OFF_SERVER',
    why: "it is named on another host than the room's chat server, which is never sent the bot's credential",
  },
  too_large: {
    code: 'SUPPORT_IMAGE_TOO_LARGE',
    why: `it is larger than the ${ROCKETCHAT_IMAGE_CAPS.bytes} bytes a picture is read at`,
  },
  gone: { code: 'SUPPORT_IMAGE_GONE', why: 'the chat server no longer holds it' },
  refused: {
    code: 'SUPPORT_IMAGE_REFUSED',
    why: "the chat server refused the bot's credential for it",
  },
  unreachable: { code: 'SUPPORT_IMAGE_UNREACHABLE', why: 'the chat server did not hand it over' },
};

/** A picture fetched, or the refusal naming why it could not be. */
export type ImageFetch =
  | { ok: true; bytes: Buffer }
  | { ok: false; code: SupportRefusalCode; why: string };

/** Fetch one recorded picture with the room's bot credential, under the read cap. */
export async function fetchRecordedImage(room: RoomRow, image: RecordedImage): Promise<ImageFetch> {
  const { auth } = await roomAuth(room);
  const got = await fetchAttachment(auth, image.ref, ROCKETCHAT_IMAGE_CAPS.bytes);
  if (got.ok) return got;
  const f = FAILURE[got.why];
  return {
    ok: false,
    code: f.code,
    why: got.status ? `${f.why} (it answered ${got.status})` : f.why,
  };
}

/** What a read hands back: the picture's bytes as base64 with its type, its name kept as data. */
export interface ImageRead {
  message: string;
  n: number;
  count: number;
  name: string;
  mime: string;
  size: number;
  dataBase64: string;
}

/** The session reads picture `n` of a member's message in its room (ISS-1010). */
export async function readImage(
  room: RoomRow,
  input: { message: string; n?: number | undefined },
): Promise<Outcome<ImageRead>> {
  const n = input.n ?? 1;
  const found = await messageImages(room.id, input.message);
  if (!found) {
    return no(
      'SUPPORT_MESSAGE_UNKNOWN',
      '/message',
      `this room received no member message ${input.message}; name a message you were handed (\`message\`)`,
    );
  }
  const image = found.images[n - 1];
  if (!image) {
    return no(
      'SUPPORT_IMAGE_UNKNOWN',
      '/n',
      found.images.length === 0
        ? `message ${input.message} carries no picture`
        : `message ${input.message} carries ${found.images.length} picture(s); n is 1..${found.images.length}`,
    );
  }
  const got = await fetchRecordedImage(room, image);
  if (!got.ok) {
    return no(
      got.code,
      '/n',
      `picture ${n} of message ${input.message} could not be read: ${got.why}. Tell the person in your own words, and ask them to post it again if it matters.`,
    );
  }
  return {
    ok: true,
    value: {
      message: input.message,
      n,
      count: found.images.length,
      name: image.name,
      mime: image.mime,
      size: got.bytes.byteLength,
      dataBase64: got.bytes.toString('base64'),
    },
  };
}
