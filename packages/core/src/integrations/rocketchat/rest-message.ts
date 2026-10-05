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

export function extractMessageImages(
  raw: Pick<RawRestMessage, 'file' | 'files' | 'attachments'>,
  baseUrl: string,
): RocketChatImageRef[] {
  const out = new Map<string, RocketChatImageRef>();
  for (const f of [raw.file, ...(raw.files ?? [])]) {
    if (!f?._id || typeof f.name !== 'string' || !IMAGE_MIME_RE.test(f.type ?? '')) continue;
    const ref = absolutize(`/file-upload/${f._id}/${encodeURIComponent(f.name)}`, baseUrl);
    out.set(ref, { name: f.name, mime: normalizeMime(f.type as string), ref });
  }
  for (const a of raw.attachments ?? []) {
    if (typeof a.image_url !== 'string' || !IMAGE_MIME_RE.test(a.image_type ?? '')) continue;
    const ref = absolutize(a.image_url, baseUrl);
    if (out.has(ref)) continue;
    const name = a.title ?? ref.split('/').pop() ?? 'image';
    out.set(ref, { name, mime: normalizeMime(a.image_type as string), ref });
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
