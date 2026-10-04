import { persistCommentAttachment } from '../comments/attachment-service.js';
import { persistIssueAttachment } from '../issues/attachment-service.js';
import { persistConversationAttachment, persistSessionAttachment } from './ports.js';
import type { UploadTicket } from './ticket-service.js';

export async function persistUpload(ticket: UploadTicket, bytes: Buffer): Promise<unknown> {
  if (ticket.targetType === 'issue') {
    return persistIssueAttachment({
      issueId: ticket.targetId,
      name: ticket.name,
      mime: ticket.mime,
      bytes,
      uploaderId: ticket.uploaderId,
      uploaderAgency: 'human',
    });
  }
  if (ticket.targetType === 'conversation') {
    return persistConversationAttachment({
      conversationId: ticket.targetId,
      name: ticket.name,
      mime: ticket.mime,
      bytes,
      uploaderId: ticket.uploaderId,
    });
  }
  if (ticket.targetType === 'session') {
    return persistSessionAttachment({
      sessionId: ticket.targetId,
      name: ticket.name,
      mime: ticket.mime,
      bytes,
      uploaderId: ticket.uploaderId,
      uploaderDeviceId: ticket.uploaderDeviceId,
    });
  }
  return persistCommentAttachment({
    commentId: ticket.targetId,
    name: ticket.name,
    mime: ticket.mime,
    bytes,
    uploaderId: ticket.uploaderId,
    uploaderDeviceId: ticket.uploaderDeviceId,
  });
}
