/**
 * The web door's half of vision: staged files become a message's `images`, and
 * a later turn reads their bytes back. The lookback, the budget and the history
 * that carries them are `vision.ts`'s; the web venue lacked only the resolver.
 */

import {
  attachmentIdFromRef,
  type ConversationAttachmentRef,
  loadConversationAttachment,
} from '../conversations/attachment-service.js';
import type { ConversationImage } from '../conversations/store.js';
import { logger } from '../logger.js';
import { getStorage } from '../storage/index.js';
import type { ImageResolver } from './vision.js';

/** The ids a send named that are not this room's, for a refusal that names them. */
export function foreignAttachmentIds(
  asked: readonly string[],
  found: readonly ConversationAttachmentRef[],
): string[] {
  const held = new Set(found.map((f) => f.id));
  return asked.filter((id) => !held.has(id));
}

export function imagesFromAttachments(
  found: readonly ConversationAttachmentRef[],
): ConversationImage[] {
  return found.map((f) => ({ name: f.name, mime: f.mime, ref: f.url }));
}

/** Read one stored image back. Null is skipped upstream: an answer without it beats none. */
export function makeConversationImageResolver(conversationId: string): ImageResolver {
  return async (image) => {
    const id = attachmentIdFromRef(conversationId, image.ref);
    if (!id) return null;
    const row = await loadConversationAttachment(conversationId, id);
    if (!row) return null;
    try {
      const bytes = await getStorage().get(row.path);
      return bytes.toString('base64');
    } catch (err) {
      logger.warn(
        { err, conversationId, attachmentId: id },
        'conversations: a stored image could not be read back for this turn',
      );
      return null;
    }
  };
}
