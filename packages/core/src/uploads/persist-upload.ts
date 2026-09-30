import {
  persistSessionAttachment,
  SessionAttachmentError,
} from '../agent-sessions/attachment-service.js';
import {
  AttachmentError as CommentAttachmentError,
  persistCommentAttachment,
} from '../comments/attachment-service.js';
import {
  ConversationAttachmentError,
  persistConversationAttachment,
} from '../conversations/attachment-service.js';
import {
  AttachmentError as IssueAttachmentError,
  persistIssueAttachment,
} from '../issues/attachment-service.js';
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

export type AttachmentRefusal = { message: string; code: string; details?: unknown };

export function attachmentRefusal(err: unknown): AttachmentRefusal | null {
  if (
    err instanceof IssueAttachmentError ||
    err instanceof CommentAttachmentError ||
    err instanceof SessionAttachmentError ||
    err instanceof ConversationAttachmentError
  ) {
    return { message: err.message, code: err.code, details: err.details };
  }
  return null;
}
