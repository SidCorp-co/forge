import { persistConversationAttachment } from './ports.js';
import type { UploadTicket } from './ticket-service.js';

/** The bytes a claimed ticket carried, stored on the conversation it was minted for. */
export async function persistUpload(ticket: UploadTicket, bytes: Buffer): Promise<unknown> {
  return persistConversationAttachment({
    conversationId: ticket.targetId,
    name: ticket.name,
    mime: ticket.mime,
    bytes,
    uploaderId: ticket.uploaderId,
  });
}
