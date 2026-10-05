import { portSlot } from '../lib/port-slot.js';

// What an upload needs from the contexts below work: the conversation attachment store a ticket
// targets. The composition root provides it at boot.

interface UploadPorts {
  persistConversationAttachment: (input: {
    conversationId: string;
    name: string;
    mime: string;
    bytes: Buffer;
    uploaderId: string;
  }) => Promise<unknown>;
}

const slot = portSlot<UploadPorts>('uploads', 'provideUploadPorts');
export const provideUploadPorts = slot.provide;
const { port } = slot;

export const persistConversationAttachment = port('persistConversationAttachment');
