// Posting an image into a room as the bot (ISS-1024): uploaded unposted first, then posted as its
// own message, so a caller can have every image on the server before its first line goes out. The
// bot's credential goes only to the connection's own server, as every REST call's does.

import type { RocketChatRestAuth } from './rest-client.js';

const apiBase = (auth: RocketChatRestAuth) => `${auth.serverUrl.replace(/\/+$/, '')}/api/v1`;

/** An image staged on the chat server and not yet posted, or why the server took none. */
export type StagedMedia = { ok: true; fileId: string } | { ok: false; why: string };

/** Uploads get the budget an upload read gets (`attachment-fetch.ts`), not a JSON call's. */
const MEDIA_TIMEOUT_MS = 20_000;

/** What a failed upload call said: the server's own error where it gave one, else its status. */
function mediaFailure(status: number, body: { error?: unknown } | null): string {
  return typeof body?.error === 'string' && body.error.length > 0
    ? `${body.error} (HTTP ${status})`
    : `HTTP ${status}`;
}

/** POST as the bot with a deadline, answering the status and the JSON body (null where none). */
async function rcSend(
  auth: RocketChatRestAuth,
  path: string,
  body: FormData | Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> | null } | { failed: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
  const form = body instanceof FormData;
  try {
    const res = await fetch(`${apiBase(auth)}/${path}`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': auth.authToken,
        'X-User-Id': auth.userId,
        Accept: 'application/json',
        ...(form ? {} : { 'Content-Type': 'application/json' }),
      },
      body: form ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, body: json };
  } catch (err) {
    return {
      failed: controller.signal.aborted
        ? `the chat server did not answer within ${MEDIA_TIMEOUT_MS / 1000}s`
        : `the chat server could not be reached (${err instanceof Error ? err.message : String(err)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upload an image into room `rid` as the bot without posting it (`rooms.media/:rid`, ISS-1024): the
 * server holds the file until {@link postStagedMedia} posts it, so every image of a post is on the
 * server before the post's first line goes out. `rooms.upload`, which posts as it uploads, is gone
 * from Rocket.Chat 7.
 */
export async function stageRoomMedia(
  auth: RocketChatRestAuth,
  rid: string,
  file: { bytes: Buffer; mime: string; name: string },
): Promise<StagedMedia> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name);
  const res = await rcSend(auth, `rooms.media/${encodeURIComponent(rid)}`, form);
  if ('failed' in res) return { ok: false, why: res.failed };
  const id = (res.body?.file as { _id?: unknown } | undefined)?._id;
  if (
    res.status >= 200 &&
    res.status < 300 &&
    res.body?.success !== false &&
    typeof id === 'string'
  ) {
    return { ok: true, fileId: id };
  }
  return { ok: false, why: mediaFailure(res.status, res.body) };
}

/**
 * Post a staged image as the bot's message in room `rid` (`rooms.mediaConfirm/:rid/:fileId`), in
 * thread `tmid` where one is given, with no words of its own: the post's text went out on its own
 * line, through the screen.
 */
export async function postStagedMedia(
  auth: RocketChatRestAuth,
  rid: string,
  fileId: string,
  tmid?: string,
): Promise<{ ok: true; messageId: string | null } | { ok: false; why: string }> {
  const res = await rcSend(
    auth,
    `rooms.mediaConfirm/${encodeURIComponent(rid)}/${encodeURIComponent(fileId)}`,
    tmid ? { tmid } : {},
  );
  if ('failed' in res) return { ok: false, why: res.failed };
  if (res.status < 200 || res.status >= 300 || res.body?.success === false) {
    return { ok: false, why: mediaFailure(res.status, res.body) };
  }
  const id = (res.body?.message as { _id?: unknown } | undefined)?._id;
  return { ok: true, messageId: typeof id === 'string' ? id : null };
}
