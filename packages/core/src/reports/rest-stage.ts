// Where a block posted over REST waits. On an Agent-mode turn's token it waits on that turn's reply,
// exactly as a chat turn's forge_show block does, and is posted only with a reply that passes the
// reply check; on a token that answers no turn it is posted now. A turn token the block cannot wait
// on is refused by name rather than posted around its reply.

import type { BlockStage } from '../lib/staged-block.js';
import { reportsPorts } from './ports.js';
import { refuse } from './runs.js';

export async function restBlockStage(args: {
  tokenId: string | null;
  conversationId: string;
}): Promise<BlockStage | null> {
  const turn = await reportsPorts().restTurnOf(args.tokenId);
  if (turn.kind === 'none') return null;
  if (turn.kind === 'assistant-turn') {
    throw refuse(
      'REPORT_BLOCK_TURN_DOOR',
      "this token is an assistant chat turn's, which draws its blocks with forge_show so they wait on its reply; a block posted here would be shown before that reply is checked",
      '/conversationId',
    );
  }
  if (turn.kind === 'session-gone') {
    throw refuse(
      'REPORT_BLOCK_TURN_UNKNOWN',
      `this token answers agent session ${turn.sessionId}, which no longer exists, so no reply is left for the block to wait on`,
      '/conversationId',
    );
  }
  if (turn.kind === 'turn-unreadable') {
    throw refuse(
      'REPORT_BLOCK_TURN_UNKNOWN',
      `this token answers agent session ${turn.sessionId}, which was started for a room turn whose room cannot be read from it, so no reply is known for the block to wait on`,
      '/conversationId',
    );
  }
  if (turn.conversationId !== args.conversationId) {
    throw refuse(
      'REPORT_BLOCK_OTHER_ROOM',
      `this Agent turn answers conversation ${turn.conversationId}, not ${args.conversationId}; a turn posts its blocks into the room it answers, where they wait on its reply`,
      '/conversationId',
    );
  }
  const settled = () =>
    refuse(
      'REPORT_BLOCK_REPLY_SETTLED',
      `the reply of agent session ${turn.sessionId} was already taken for delivery, so a block posted now has no reply to go out with; draw blocks before the session writes its reply`,
      '/conversationId',
    );
  if (turn.settled) throw settled();
  return {
    hold: async (block) => {
      if (!(await turn.stage(block))) throw settled();
    },
  };
}
