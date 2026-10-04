// What an upload needs from the contexts below work: the session and conversation attachment
// stores a ticket may target. The composition root provides them at boot.

export interface UploadPorts {
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

let provided: UploadPorts | null = null;

export function provideUploadPorts(given: UploadPorts): void {
  provided = given;
}

function uploadPorts(): UploadPorts {
  if (!provided) {
    throw new Error(
      'uploads: no ports were provided; the process entry calls provideUploadPorts before it serves',
    );
  }
  return provided;
}

export const persistConversationAttachment: UploadPorts['persistConversationAttachment'] = (
  input,
) => uploadPorts().persistConversationAttachment(input);
export const persistSessionAttachment: UploadPorts['persistSessionAttachment'] = (input) =>
  uploadPorts().persistSessionAttachment(input);
