import { portSlot } from '../lib/port-slot.js';

// What an upload needs from the contexts below work: the conversation attachment store a ticket
// targets, and the feedback attachment a fetch names (ISS-879). The composition root provides them
// at boot.

/** A feedback item's file as a fetch reads it: where its bytes are, and whether a model may see them. */
export interface FeedbackAttachmentRow {
  name: string;
  mime: string;
  size: number;
  path: string;
  projectId: string;
  url: string;
  /** The attacher's word that nothing personal shows in it (REQ-66 BC-7). */
  redacted: boolean;
}

interface UploadPorts {
  persistConversationAttachment: (input: {
    conversationId: string;
    name: string;
    mime: string;
    bytes: Buffer;
    uploaderId: string;
  }) => Promise<unknown>;
  feedbackAttachmentOf: (attachmentId: string) => Promise<FeedbackAttachmentRow | null>;
}

const slot = portSlot<UploadPorts>('uploads', 'provideUploadPorts');
export const provideUploadPorts = slot.provide;
const { port } = slot;

export const persistConversationAttachment = port('persistConversationAttachment');
export const feedbackAttachmentOf = port('feedbackAttachmentOf');
