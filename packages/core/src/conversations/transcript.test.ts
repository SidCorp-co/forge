// A reply's transcript write, when it fails: a venue that already showed the reply keeps it and the
// failure is logged; a web room, whose transcript is the only place the reply exists, is told.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./store.js', () => ({
  appendMessage: async () => {
    throw new Error('conversation_messages: the write failed');
  },
  findConversation: async () => null,
}));

vi.mock('./participants.js', () => ({ handleForProject: async () => null }));

const { recordDeliveredReply } = await import('./transcript.js');

const reply = {
  conversationId: '218168c7-41da-4ec2-9f3a-903d5af29aeb',
  projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
  text: 'The agent stopped before it answered. Send your message again.',
  receipt: { messageId: 'm-1' },
};

describe('a delivered reply the transcript cannot record', () => {
  it('is kept as delivered where the venue already showed it', async () => {
    await expect(recordDeliveredReply(reply)).resolves.toBeUndefined();
  });

  it('is refused to the caller where the row is the delivery', async () => {
    await expect(recordDeliveredReply({ ...reply, isTheDelivery: true })).rejects.toThrow(
      'conversation_messages: the write failed',
    );
  });
});
