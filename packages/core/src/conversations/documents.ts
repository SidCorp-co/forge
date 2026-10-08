/**
 * A room's documents read back as text: by the reference a message carries (the turn that shows the
 * model what was attached) and by the file name a person and the model call it (a tool that takes
 * the document's own lines). Every text handed out here went through the scrubber.
 */

import { getStorage } from '../integrations/index.js';
import { safeName } from '../lib/attachment-mime.js';
import { readDocumentText } from '../lib/document-text.js';
import { logger } from '../lib/logger.js';
import {
  attachmentIdFromRef,
  listConversationDocuments,
  loadConversationAttachment,
} from './attachment-service.js';

export type RoomDocument =
  | { ok: true; name: string; mime: string; text: string; redacted: boolean }
  | { ok: false; reason: string };

async function textOf(row: { name: string; mime: string; path: string }): Promise<RoomDocument> {
  let bytes: Buffer;
  try {
    bytes = await getStorage().get(row.path);
  } catch (err) {
    logger.warn({ err, file: row.name }, 'conversations: a stored document could not be read back');
    return {
      ok: false,
      reason: `${row.name} is held by this room, but its bytes could not be read back from storage`,
    };
  }
  const read = await readDocumentText(bytes, row.mime);
  if (!read.ok)
    return { ok: false, reason: `${row.name} cannot be read as a document: ${read.reason}` };
  return { ok: true, name: row.name, mime: row.mime, text: read.text, redacted: read.redacted };
}

/** The document a message's `ref` names in this room, as scrubbed text. */
export async function readRoomDocumentByRef(
  conversationId: string,
  ref: string,
): Promise<RoomDocument> {
  const id = attachmentIdFromRef(conversationId, ref);
  const row = id ? await loadConversationAttachment(conversationId, id) : null;
  if (!row) return { ok: false, reason: `the file at ${ref} is not one this room holds` };
  return textOf(row);
}

/**
 * The newest document in this room stored under `file`, as scrubbed text. The name is matched as
 * stored and as it would be stored, since a name with a space is kept with an underscore; a name
 * that matches nothing is refused with the names that do exist.
 */
export async function readRoomDocumentByName(
  conversationId: string,
  file: string,
): Promise<RoomDocument> {
  const held = await listConversationDocuments(conversationId);
  const wanted = new Set([file.trim(), safeName(file.trim())]);
  const row = held.find((d) => wanted.has(d.name));
  if (row) return textOf(row);
  const names = [...new Set(held.map((d) => d.name))];
  return {
    ok: false,
    reason:
      names.length === 0
        ? `no document is attached in this conversation, so there is no ${file} to read — ask the person to attach it`
        : `no document named ${file} is attached in this conversation; it holds ${names.join(', ')}`,
  };
}
