// What the stand-in chat server (`support-chat-server.ts`) does with lines and files already held:
// a member's upload served to the bot, and the bot's own line changed or removed (ISS-1238).

import type { ServerResponse } from 'node:http';
import type { BotLine } from './support-chat-server.js';

/** `/file-upload/<id>/<name>`: a member's upload, as Rocket.Chat serves it to the bot (ISS-1010). */
export function serveUpload(
  uploads: ReadonlyMap<string, { bytes: Buffer; mime: string; status?: number }>,
  reads: string[],
  path: string,
  res: ServerResponse,
): void {
  const id = path.split('/')[2] ?? '';
  reads.push(id);
  const file = uploads.get(id);
  if (!file || file.status) {
    res.writeHead(file?.status ?? 404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'content-type': file.mime,
    'content-length': String(file.bytes.byteLength),
  });
  res.end(file.bytes);
}

/**
 * `chat.update` or `chat.delete` (by `path`) of one of the bot's lines in the room it names: the line
 * takes the new text, or leaves `lines` for `deleted` (ISS-1238).
 */
export function changeLine(
  lines: (BotLine & { rid: string })[],
  deleted: BotLine[],
  path: string,
  body: Record<string, unknown>,
): [number, unknown] {
  const at = lines.findIndex((l) => l.id === body.msgId && l.rid === body.roomId);
  const line = lines[at];
  if (!line) return [400, { success: false, error: 'error-message-not-found' }];
  if (path.endsWith('chat.update')) line.text = String(body.text);
  else deleted.push(...lines.splice(at, 1));
  return [200, { success: true, message: { _id: line.id } }];
}
