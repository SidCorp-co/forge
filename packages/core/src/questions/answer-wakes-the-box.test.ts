// cm:why criterion 44 makes an answer a trigger source for `master.wake`, and the
// claim is about the CALL SITE rather than the publisher: `ws/master-wake.test.ts`
// proves the frame is right, and deleting the one line in `answerQuestion` leaves
// that suite entirely green while every box learns of the answer only on its next
// 30-second sweep.

import { describe, expect, it, vi } from 'vitest';

type WakeArgs = { projectId: string; questionId: string };
const wakeMastersForAnswer = vi.fn(async (_a: WakeArgs) => ({ boxes: 1, delivered: 1 }));
vi.mock('../ws/master-wake.js', () => ({
  wakeMastersForAnswer: (a: WakeArgs) => wakeMastersForAnswer(a),
}));

const ROW = {
  id: 'q-1',
  projectId: 'p-1',
  steps: [{ round: 1, prompt: 'which?', options: [{ id: 'o-1' }], recommendedOptionId: 'o-1' }],
  status: 'open',
  maxRounds: 3,
};

const where = vi.fn(async () => undefined);
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [ROW] }) }) }),
    update: () => ({ set: () => ({ where }) }),
  },
}));

const { answerQuestion } = await import('./write.js');

describe('answering a question', () => {
  it('wakes the boxes serving that project, naming the question', async () => {
    await answerQuestion({ questionId: 'q-1', optionId: 'o-1', by: 'u-1' });

    expect(
      wakeMastersForAnswer,
      'an answer nobody is told about is an answer the box finds on its next sweep — criterion 44 makes it a trigger source, not a row somebody eventually notices',
    ).toHaveBeenCalledWith({ projectId: 'p-1', questionId: 'q-1' });
  });

  // cm:guard the ORDER, which a `toHaveBeenCalledWith` cannot see: a wake published before the row is written sends the box to read an answer that is not there, and it then waits out the full sweep anyway — worse than not publishing, because the read comes back empty and looks authoritative.
  it('publishes only after the write has landed', async () => {
    const order: string[] = [];
    where.mockImplementationOnce(async () => {
      order.push('write');
    });
    wakeMastersForAnswer.mockImplementationOnce(async () => {
      order.push('wake');
      return { boxes: 1, delivered: 1 };
    });

    await answerQuestion({ questionId: 'q-1', optionId: 'o-1', by: 'u-1' });

    expect(order).toEqual(['write', 'wake']);
  });
});
