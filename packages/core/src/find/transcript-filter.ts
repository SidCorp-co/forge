// A room's transcript search as a filter of the find door (ISS-1256): the room's
// `conversation_transcript_search` tool answers the door's conversation filter over that room, in its
// order, with the room read's own coverage and limits. The room's fence decides who reads it.

import type { TranscriptRead } from './arms-shared.js';
import { runFind } from './service.js';

export interface TranscriptFilterInput {
  conversationId: string;
  /** The project the room's turn answers in: where its passages are found. */
  projectId: string;
  /** Whose authority the turn runs under; the room's fence is asked about them. */
  userId: string;
  query: string;
  /** How many passages were asked for; the room answers at most its own cap and says so. */
  limit: number;
  venueLimitation?: string | undefined;
}

/** The room's passages the door keeps for `query`, with how far the room's index reaches. */
export async function transcriptThroughFind(input: TranscriptFilterInput): Promise<TranscriptRead> {
  const { kept, transcript } = await runFind({
    projectId: input.projectId,
    projectIds: [input.projectId],
    query: {
      q: input.query,
      type: ['conversation'],
      limit: input.limit,
      conversation: input.conversationId,
    },
    reader: { userId: input.userId, fence: [input.projectId] },
    askedBy: 'agent',
    filterOnly: true,
    venueLimitation: input.venueLimitation,
  });
  if (!transcript) throw new Error('find: the conversation filter ran no transcript read');
  return {
    ...transcript,
    matches: kept.map((c) => c.native as TranscriptRead['matches'][number]),
  };
}
