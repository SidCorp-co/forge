import { portSlot } from '../lib/port-slot.js';

// What an upload needs from the contexts below work: the session and conversation attachment
// stores a ticket may target. The composition root provides them at boot.

interface UploadPorts {
  persistConversationAttachment: (input: {
    conversationId: string;
    name: string;
    mime: string;
    bytes: Buffer;
    uploaderId: string;
  }) => Promise<unknown>;
  persistSessionAttachment: (input: {
    sessionId: string;
    name: string;
    mime: string;
    bytes: Buffer;
    uploaderId: string;
    uploaderDeviceId: string | null;
  }) => Promise<unknown>;
}

const slot = portSlot<UploadPorts>('uploads', 'provideUploadPorts');
export const provideUploadPorts = slot.provide;
const { port } = slot;

export const persistConversationAttachment = port('persistConversationAttachment');
export const persistSessionAttachment = port('persistSessionAttachment');
