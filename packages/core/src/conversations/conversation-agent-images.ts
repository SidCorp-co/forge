import { persistSessionAttachment } from '../agent-sessions/index.js';
import { getStorage } from '../integrations/index.js';
import { logger } from '../lib/logger.js';
import { attachmentIdFromRef, loadConversationAttachment } from './attachment-service.js';
import type { ConversationImage } from './store.js';

/**
 * Copy the room's pictures onto this turn's session, so the box that answers
 * can open them. A box reads session attachments and has no way to reach a
 * conversation's, so a turn dispatched without this copy answers a question
 * about a picture it was never shown.
 *
 * A picture that cannot be copied stops the turn rather than being left out:
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
      const bytes = await getStorage().get(row.path);
      const copy = await persistSessionAttachment({
        sessionId,
        name: row.name,
        mime: row.mime,
        bytes,
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
