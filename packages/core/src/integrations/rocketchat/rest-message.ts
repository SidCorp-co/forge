import { ROOM_IMAGE_CAPS } from '@forge/contracts/support';

/** Simplified REST message (both history + thread endpoints map to this). */
export interface RocketChatRestMessage {
  id: string;
  text: string;
  userId: string;
  username: string;
  /** ISO timestamp. */
  ts: string;
  isSystem: boolean;
  /** The room the server says this message is in; absent on a payload that named none (ISS-1087). */
  rid?: string | undefined;
  /** The thread it was posted inside, where it was. */
  tmid?: string | undefined;
}

interface RawRestFile {
  _id?: string;
  name?: string;
  type?: string;
}

export interface RawRestMessage {
  _id?: string;
  rid?: string;
  tmid?: string;
  msg?: string;
  ts?: string;
  t?: string;
  u?: { _id?: string; username?: string };
  file?: RawRestFile;
  files?: RawRestFile[];
  attachments?: Array<{
    title?: string;
    text?: string;
    description?: string;
    title_link?: string;
    message_link?: string;
    image_url?: string;
    image_type?: string;
  }>;
}

/** An image uploaded to a room, addressed by an absolute, credentialed URL. */
export interface RocketChatImageRef {
  name: string;
  mime: string;
  /** `<serverUrl>/file-upload/<id>/<name>` — reachable only with the bot's
   *  `X-Auth-Token`/`X-User-Id`, and only by following one redirect. */
  ref: string;
}

/**
 * How much of a message's pictures core reads, wherever it reads them: the chat-room Assistant's
 * turn and a support room's session (ISS-1010) alike. A room can attach a dozen files to one post;
 * a reader gains nothing from the tail, and each one costs a download plus its share of the vision
 * budget.
 */
export const ROCKETCHAT_IMAGE_CAPS = ROOM_IMAGE_CAPS;

const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp)$/i;

function normalizeMime(raw: string): string {
  const mime = raw.toLowerCase();
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function absolutize(link: string, baseUrl: string | undefined): string {
  if (!link.startsWith('/') || !baseUrl) return link;
  return `${baseUrl.replace(/\/+$/, '')}${link}`;
}

export function extractMessageText(
  raw: Pick<RawRestMessage, 'msg' | 'attachments'>,
  baseUrl?: string,
): string {
  const parts: string[] = [];
  if (typeof raw.msg === 'string' && raw.msg.length > 0) parts.push(raw.msg);
  for (const a of raw.attachments ?? []) {
    const title = [a.title, a.title_link ? `(${absolutize(a.title_link, baseUrl)})` : null]
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .join(' ');
    for (const field of [title, a.text, a.description, a.message_link]) {
      if (typeof field === 'string' && field.trim().length > 0) {
        parts.push(field === a.message_link ? absolutize(field, baseUrl) : field);
      }
    }
  }
  return parts.join('\n');
}

const UPLOAD_ID_RE = /\/file-upload\/([^/?#]+)\//;

/**
 * One ref per picture. Rocket.Chat records one image upload three times: the upload on
 * `file`/`files`, its `thumb-<name>` copy on `files`, and an attachment whose `image_url` is the
 * thumbnail's id under the original name, `encodeURI`d. The thumbnail is skipped and every
 * `/file-upload` ref is keyed by its upload id, so neither copy reads as a picture of its own.
 */
export function extractMessageImages(
  raw: Pick<RawRestMessage, 'file' | 'files' | 'attachments'>,
  baseUrl: string,
): RocketChatImageRef[] {
  const out = new Map<string, RocketChatImageRef>();
  const files = [raw.file, ...(raw.files ?? [])].filter(
    (f): f is RawRestFile & { _id: string; name: string } =>
      !!f?._id && typeof f.name === 'string' && IMAGE_MIME_RE.test(f.type ?? ''),
  );
  const names = new Set(files.map((f) => f.name));
  const thumbs = new Set<string>();
  for (const f of files) {
    if (f.name.startsWith('thumb-') && names.has(f.name.slice('thumb-'.length))) {
      thumbs.add(f._id);
      continue;
    }
    if (out.has(f._id)) continue;
    const ref = absolutize(`/file-upload/${f._id}/${encodeURIComponent(f.name)}`, baseUrl);
    out.set(f._id, { name: f.name, mime: normalizeMime(f.type as string), ref });
  }
  for (const a of raw.attachments ?? []) {
    if (typeof a.image_url !== 'string' || !IMAGE_MIME_RE.test(a.image_type ?? '')) continue;
    const ref = absolutize(a.image_url, baseUrl);
    const key = UPLOAD_ID_RE.exec(a.image_url)?.[1] ?? ref;
    if (out.has(key) || thumbs.has(key)) continue;
    const name = a.title ?? ref.split('/').pop() ?? 'image';
    out.set(key, { name, mime: normalizeMime(a.image_type as string), ref });
  }
  return [...out.values()];
}

export function mapMessage(raw: RawRestMessage, baseUrl?: string): RocketChatRestMessage | null {
  if (!raw || typeof raw._id !== 'string' || !raw.u?._id) return null;
  return {
    id: raw._id,
    text: extractMessageText(raw, baseUrl),
    userId: raw.u._id,
    username: raw.u.username ?? raw.u._id,
    ts: typeof raw.ts === 'string' ? raw.ts : '',
    isSystem: typeof raw.t === 'string' && raw.t.length > 0,
    ...(typeof raw.rid === 'string' ? { rid: raw.rid } : {}),
    ...(typeof raw.tmid === 'string' ? { tmid: raw.tmid } : {}),
  };
}

/** Map a REST `messages` array, dropping entries that are not messages, oldest-first. */
export function mapMessages(raw: unknown[], baseUrl: string): RocketChatRestMessage[] {
  return raw
    .map((m) => mapMessage(m as RawRestMessage, baseUrl))
    .filter((m): m is RocketChatRestMessage => m !== null)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}
