// Reading an uploaded file off the chat server with the bot's credential (ISS-1010): the credential
// goes only to the server's own origin, on the first request and on every redirect.

import type { RocketChatRestAuth } from './rest-client.js';

/** Uploads are big and slow next to a JSON read; give them their own budget. */
const FILE_FETCH_TIMEOUT_MS = 20_000;
/** How many redirects an upload read follows before it says the server did not hand the file over. */
const MAX_FILE_REDIRECTS = 3;

/** Why an uploaded file could not be read, each a different thing to tell whoever asked. */
export type AttachmentFetchFailure =
  /** The ref is not on the connection's own server: the bot's credential is never sent elsewhere. */
  | 'off_server'
  /** Larger than the reader's cap, by its declared length or by what arrived. */
  | 'too_large'
  /** The server holds no such file any more (404, 410). */
  | 'gone'
  /** The server refused the bot's credential (401, 403). */
  | 'refused'
  /** The server answered no file: an empty body, another status, a timeout or no route. */
  | 'unreachable';

export type AttachmentFetch =
  | { ok: true; bytes: Buffer }
  | { ok: false; why: AttachmentFetchFailure; status?: number };

/** Whether `ref` is on the server `auth` holds a credential for: same scheme, host and port. */
function onServer(auth: RocketChatRestAuth, ref: string): boolean {
  try {
    return new URL(ref).origin === new URL(auth.serverUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Download an uploaded file's bytes with the bot credential, or say why not.
 *
 * `maxBytes` is enforced against `content-length` BEFORE the body is read, so an oversized upload
 * costs a HEAD-shaped round-trip rather than a buffer the process then throws away. A ref on any
 * other host than the connection's server is never fetched: a message's attachment can name any URL,
 * and the bot's token would go with it (ISS-1010). Redirects are followed by hand for the same reason:
 * fetch drops only `Authorization` on a cross-origin hop, never `X-Auth-Token`, so a server that sends
 * uploads on to object storage would hand that host the bot's token. The credential goes only to a hop
 * on the server's own origin; a hop elsewhere (a signed storage URL) is fetched bare.
 */
export async function fetchAttachment(
  auth: RocketChatRestAuth,
  ref: string,
  maxBytes: number,
): Promise<AttachmentFetch> {
  if (!onServer(auth, ref)) return { ok: false, why: 'off_server' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_FETCH_TIMEOUT_MS);
  try {
    let url = ref;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_FILE_REDIRECTS; hop += 1) {
      res = await fetch(url, {
        headers: onServer(auth, url)
          ? { 'X-Auth-Token': auth.authToken, 'X-User-Id': auth.userId }
          : {},
        redirect: 'manual',
        signal: controller.signal,
      });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!next) break;
      url = new URL(next, url).toString();
      res = null;
    }
    if (!res) return { ok: false, why: 'unreachable' };
    if (res.status === 404 || res.status === 410) {
      return { ok: false, why: 'gone', status: res.status };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, why: 'refused', status: res.status };
    }
    if (!res.ok) return { ok: false, why: 'unreachable', status: res.status };
    const declared = Number(res.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, why: 'too_large' };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) return { ok: false, why: 'too_large' };
    if (bytes.byteLength === 0) return { ok: false, why: 'unreachable', status: res.status };
    return { ok: true, bytes };
  } catch {
    return { ok: false, why: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download an uploaded file's bytes with the bot credential: null on any failure, where a picture
 * the bot cannot fetch degrades the answer and never fails the turn (the chat-room Assistant).
 */
export async function fetchAttachmentBytes(
  auth: RocketChatRestAuth,
  ref: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const got = await fetchAttachment(auth, ref, maxBytes);
  return got.ok ? got.bytes : null;
}
