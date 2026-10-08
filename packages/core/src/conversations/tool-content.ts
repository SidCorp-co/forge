// A delivered reply's tool calls are the asker's. The turn that made them ran with the asker's
// permissions, so a call's input, its output and the act it offers can hold what another member of
// the room may not read; every other reader is shown which tools ran and for how long, and the
// reply (REQ-32, lane A8d — the design decision delegated to the lane). The live turn is split the
// same way at its fan-out (`assistant/conversation-progress.ts`); this is the stored row's split,
// taken on every read that hands a message out.

import type { ContentBlock } from '../lib/agent-stream-parser.js';

/** Whose turn wrote this reply, as its delivery recorded it; null where nothing recorded one. */
export function askerOfReply(deliveryProof: unknown): string | null {
  if (!deliveryProof || typeof deliveryProof !== 'object') return null;
  const askedBy = (deliveryProof as { askedBy?: unknown }).askedBy;
  return typeof askedBy === 'string' && askedBy !== '' ? askedBy : null;
}

/** One block as a reader who did not ask is shown it: a tool by name and time, a pause by time. */
function forRoom(block: ContentBlock): ContentBlock {
  if (block.type === 'tool' && block.toolCall) {
    const { id, name, durationMs, isError } = block.toolCall;
    return {
      type: 'tool',
      toolCall: {
        id,
        name,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(isError === true ? { isError } : {}),
        withheld: true,
      },
    };
  }
  if (block.type === 'thinking') {
    return {
      type: 'thinking',
      ...(block.durationMs !== undefined ? { durationMs: block.durationMs } : {}),
    };
  }
  return block;
}

const carriesToolContent = (b: ContentBlock) =>
  (b.type === 'tool' && !!b.toolCall) || (b.type === 'thinking' && !!b.thinking);

/**
 * The message as `viewerId` may read it: whole for the person whose turn wrote it, and for anyone
 * else with every tool input and output and every reasoning text taken out. A reply whose delivery
 * named no asker (one stored before the asker was recorded) is nobody's, so its tool content is
 * shown to no one rather than to everyone.
 */
export function toolContentFor<M extends { blocks: ContentBlock[] | null; deliveryProof: unknown }>(
  message: M,
  viewerId: string | null,
): M {
  const blocks = message.blocks;
  if (!blocks?.some(carriesToolContent)) return message;
  const asker = askerOfReply(message.deliveryProof);
  if (asker !== null && asker === viewerId) return message;
  return { ...message, blocks: blocks.map(forRoom) };
}
