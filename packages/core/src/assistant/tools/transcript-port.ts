// The room's transcript search as a filter of the find door (ISS-1256): the tool reads the door's
// conversation filter, a read model the assistant may not import, so the composition root fills this
// at boot (`index.ts`, from `find/transcript-filter.ts`).

import type { searchConversationTranscript } from '../../conversations/index.js';
import { portSlot } from '../../lib/port-slot.js';

/** One room read: its passages in the door's order, how far its index reaches, what it could not show. */
export type TranscriptFound = Awaited<ReturnType<typeof searchConversationTranscript>>;

const slot = portSlot<{
  transcriptThroughFind: (input: {
    conversationId: string;
    projectId: string;
    userId: string;
    query: string;
    limit: number;
    venueLimitation?: string | undefined;
  }) => Promise<TranscriptFound>;
}>('assistant transcript', 'provideTranscriptFindPort');
export const provideTranscriptFindPort = slot.provide;
export const transcriptThroughFind = slot.port('transcriptThroughFind');
