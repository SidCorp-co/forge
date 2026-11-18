// The pictures a record carries (ISS-1327): only those the session names as evidence, by message and
// place, never the thread's every picture. adminhub-fe FB-29 was filed with nine of its thread's
// pictures, one of them a supplier form with its secret key in clear: the text filter had kept the
// key out of that message's words, and nothing read the picture. A picture from a message whose text
// had a secret filtered is never attached, named or not; one no member message of the thread carries
// is refused by name. Attached as before (ISS-1010): fetched with the room's bot credential and
// stored under the project the item was filed in (ISS-1088).

import { FEEDBACK_LIMITS } from '@forge/contracts/feedback';
import type { SupportRefusalCode } from '@forge/contracts/support';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { attachToFiled } from '../feedback/index.js';
import { logger } from '../lib/logger.js';
import { fetchRecordedImage, type RecordedImage, threadImages } from './images.js';
import { refusalOf } from './refusals.js';
import type { RoomRow } from './store.js';

/** A picture named as evidence: its message, and its place there (every picture of it, omitted). */
export interface NamedPicture {
  message: string;
  n?: number | undefined;
}

/** A picture named that cannot go, with where it was named. */
export interface PictureFault {
  at: number;
  message: string;
  n: number | null;
  code: Extract<SupportRefusalCode, 'SUPPORT_PICTURE_UNKNOWN' | 'SUPPORT_PICTURE_HELD_SECRET'>;
  why: string;
}

/** The messages of a room whose text had a secret filtered, of those asked. */
async function secretMessages(roomId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ message: sql<string>`${supportActions.input}->>'message'` })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'secret_flagged'),
        inArray(sql`${supportActions.input}->>'message'`, [...ids]),
      ),
    );
  return new Set(rows.map((r) => r.message));
}

/**
 * The thread's pictures each named entry picks, in the order named and each once, and the entries
 * that pick none: a message of the thread carrying no picture there, or one whose secret was filtered.
 */
export async function picturesNamed(
  roomId: string,
  thread: string,
  named: readonly NamedPicture[],
): Promise<{
  chosen: { message: string; n: number; image: RecordedImage }[];
  faults: PictureFault[];
}> {
  if (named.length === 0) return { chosen: [], faults: [] };
  const all = await threadImages(roomId, thread);
  const secret = await secretMessages(
    roomId,
    named.map((p) => p.message),
  );
  const chosen: { message: string; n: number; image: RecordedImage }[] = [];
  const faults: PictureFault[] = [];
  for (const [at, p] of named.entries()) {
    const n = p.n ?? null;
    if (secret.has(p.message)) {
      faults.push({
        at,
        message: p.message,
        n,
        code: 'SUPPORT_PICTURE_HELD_SECRET',
        why: `message ${p.message} held a secret Forge filtered, so none of its pictures is attached: a picture beside a secret may show it`,
      });
      continue;
    }
    const picked = all.filter((i) => i.message === p.message && (n === null || i.n === n));
    if (picked.length === 0) {
      const has = all.filter((i) => i.message === p.message).length;
      faults.push({
        at,
        message: p.message,
        n,
        code: 'SUPPORT_PICTURE_UNKNOWN',
        why: has
          ? `message ${p.message} carries ${has} picture(s); n is 1..${has}`
          : `no member message ${p.message} of this thread carries a picture`,
      });
      continue;
    }
    for (const i of picked) {
      if (!chosen.some((c) => c.message === i.message && c.n === i.n)) chosen.push(i);
    }
  }
  return { chosen, faults };
}

/** What became of the pictures named for an item: how many went, and each that did not, with why. */
export interface FiledPictures {
  attached: number;
  notAttached: { message: string; n: number | null; code: string; why: string }[];
}

/**
 * Attach the pictures the record named to the item filed from it, up to the most one item keeps:
 * each fetched with the room's bot credential, as the session reads it. One that cannot be fetched,
 * kept or named is listed with why; the filing stands either way. Null where none was named.
 */
export async function attachNamedPictures(
  room: RoomRow,
  projectId: string,
  thread: string,
  itemId: string,
  named: readonly NamedPicture[],
): Promise<FiledPictures | null> {
  if (named.length === 0) return null;
  const { chosen, faults } = await picturesNamed(room.id, thread, named);
  const notAttached: FiledPictures['notAttached'] = faults.map(({ message, n, code, why }) => ({
    message,
    n,
    code,
    why,
  }));
  for (const p of chosen.slice(FEEDBACK_LIMITS.attachmentsPerItem)) {
    notAttached.push({
      message: p.message,
      n: p.n,
      code: 'FEEDBACK_ATTACHMENTS_FULL',
      why: `an item keeps at most ${FEEDBACK_LIMITS.attachmentsPerItem} attachments`,
    });
  }
  const files: { name: string; mime: string; contentBase64: string }[] = [];
  const sources: { message: string; n: number }[] = [];
  for (const p of chosen.slice(0, FEEDBACK_LIMITS.attachmentsPerItem)) {
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
  if (files.length === 0) return { attached: 0, notAttached };
  // the item is filed by now: a picture that breaks on the way is named on it, never a throw that
  // hides the filing from the session (ISS-1088)
  const put = await attachToFiled({
    projectId,
    itemId,
    uploadedBy: room.principalUserId,
    files,
  }).catch((err: unknown) => {
    logger.error({ err, roomId: room.id, itemId }, 'support: attaching a named picture threw');
    const why = `attaching the pictures broke (${err instanceof Error ? err.message : String(err)}), so the item may hold none or only some of them`;
    return {
      attached: [],
      refused: files.map((_, file) => ({
        file,
        refusal: refusalOf('SUPPORT_REFUSED', `/files/${file}`, why),
      })),
    };
  });
  for (const { file, refusal } of put.refused) {
    // `files` and `sources` are built side by side, so each refused file has its source
    const source = sources[file] as { message: string; n: number };
    notAttached.push({ ...source, code: refusal.code, why: refusal.detail });
  }
  return { attached: put.attached.length, notAttached };
}
