import { persistSessionAttachment } from '../agent-sessions/index.js';
import { getStorage } from '../integrations/index.js';
import { isDocumentMime, readDocumentText } from '../lib/document-text.js';
import { logger } from '../lib/logger.js';
import { attachmentIdFromRef, loadConversationAttachment } from './attachment-service.js';
import type { ConversationImage } from './store.js';

/**
 * Copy the room's pictures onto this turn's session, so the box that answers
 * can open them. A box reads session attachments and has no way to reach a
 * conversation's, so a turn dispatched without this copy answers a question
 * about a picture it was never shown.
 *
 * A document goes as its scrubbed text, never its bytes: a box is sent what the
 * Assistant-mode model is sent, so a secret the scrubber takes out of a turn here
 * does not reach the box beside it. Markdown and plain text keep their name; any
 * other document's text goes as `<name>.txt`.
 *
 * A file that cannot be copied stops the turn rather than being left out:
 * an answer written without the file it was asked about is worse than no
 * answer, and the caller names the file in what it posts instead.
 */
export async function carryImagesToSession(
  conversationId: string,
  sessionId: string,
  images: readonly ConversationImage[],
): Promise<{ ok: true; ids: string[] } | { ok: false; file: string }> {
  const ids: string[] = [];
  for (const image of images) {
    const attachmentId = attachmentIdFromRef(conversationId, image.ref);
    if (!attachmentId) return { ok: false, file: image.name };
    const row = await loadConversationAttachment(conversationId, attachmentId);
    if (!row) return { ok: false, file: image.name };
    try {
      const stored = await getStorage().get(row.path);
      const carried = isDocumentMime(row.mime) ? await asText(row.name, row.mime, stored) : null;
      if (carried === false) return { ok: false, file: row.name };
      const copy = await persistSessionAttachment({
        sessionId,
        name: carried?.name ?? row.name,
        mime: carried?.mime ?? row.mime,
        bytes: carried?.bytes ?? stored,
        uploaderId: row.uploaderId,
        uploaderDeviceId: null,
      });
      ids.push(copy.id);
    } catch (err) {
      logger.error(
        { err, conversationId, sessionId, attachmentId },
        'conversation-agent: a picture could not be carried to the session',
      );
      return { ok: false, file: row.name };
    }
  }
  return { ok: true, ids };
}

const KEPT_TEXT_TYPES = new Set(['text/markdown', 'text/plain']);

/** A document as the scrubbed text a session takes, or false where it has none to give. */
async function asText(
  name: string,
  mime: string,
  bytes: Buffer,
): Promise<{ name: string; mime: string; bytes: Buffer } | false> {
  const read = await readDocumentText(bytes, mime);
  if (!read.ok) return false;
  const kept = KEPT_TEXT_TYPES.has(mime);
  return {
    name: kept ? name : `${name}.txt`,
    mime: kept ? mime : 'text/plain',
    bytes: Buffer.from(read.text, 'utf8'),
  };
}
