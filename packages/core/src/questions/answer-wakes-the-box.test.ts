// cm:why criterion 44 makes an answer a trigger source for `master.wake`, and the
// claim is about the CALL SITE rather than the publisher: `ws/master-wake.test.ts`
// proves the frame is right, and deleting the one line in `answerQuestion` leaves
// that suite entirely green while every box learns of the answer only on its next
// 30-second sweep.
//
// The transaction is modelled with the callback finishing and the transaction
// RESOLVING as two separate events, because that gap is exactly where a wake
// published too early would tell a box to read an answer no commit ever left
// (ISS-980 criteria 36, 37, 38).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionStep } from '../db/schema-questions.js';

type WakeArgs = { projectId: string; questionId: string };
const wakeMastersForAnswer = vi.fn(async (_a: WakeArgs) => ({ boxes: 1, delivered: 1 }));
vi.mock('../ws/master-wake.js', () => ({
  wakeMastersForAnswer: (a: WakeArgs) => wakeMastersForAnswer(a),
}));

const WRITER = { id: 'o-1', label: 'Safe path', authority: 'writer', bindsTo: 'session' };
const ADMIN = { id: 'o-2', label: 'Deploy it', authority: 'admin', bindsTo: 'project' };

type Row = {
  id: string;
  projectId: string;
  status: string;
  steps: QuestionStep[];
  maxRounds: number;
  parkDeadlineAt: Date | null;
};

function aRow(over: Partial<Row> = {}): Row {
  return {
    id: 'q-1',
    projectId: 'p-1',
    status: 'open',
    steps: [
      { round: 1, prompt: 'which?', options: [WRITER, ADMIN], recommendedOptionId: 'o-1' },
    ] as unknown as QuestionStep[],
    maxRounds: 3,
    parkDeadlineAt: null,
    ...over,
  };
}

let row: Row;
let commit: Promise<void>;
let releaseCommit: () => void;
let rejectCommit: (e: Error) => void;
const update = vi.fn(async () => undefined);

// cm:guard `transaction` awaits the callback and THEN awaits `commit` — that second await is the whole point of this mock. Collapse it and a wake published inside the callback is indistinguishable from one published after the row is durable, which is the failure criterion 38 names.
vi.mock('../db/client.js', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const out = await fn({
        select: () => ({
          from: () => ({ where: () => ({ limit: () => ({ for: async () => [row] }) }) }),
        }),
        update: () => ({ set: () => ({ where: update }) }),
      });
      await commit;
      return out;
    },
  },
}));

const { answerQuestion, QuestionRefused } = await import('./write.js');

const answer = (over: Partial<Parameters<typeof answerQuestion>[0]> = {}) =>
  answerQuestion({
    questionId: 'q-1',
    optionId: 'o-1',
    round: 1,
    by: 'u-1',
    role: 'member',
    ...over,
  });

beforeEach(() => {
  row = aRow();
  update.mockClear();
  wakeMastersForAnswer.mockClear();
  commit = new Promise<void>((res, rej) => {
    releaseCommit = () => res();
    rejectCommit = rej;
  });
});

afterEach(() => {
  releaseCommit();
});

describe('answering a question', () => {
  it('wakes the boxes serving that project, naming the question', async () => {
    releaseCommit();
    await answer();

    expect(
      wakeMastersForAnswer,
      'an answer nobody is told about is an answer the box finds on its next sweep — criterion 44 makes it a trigger source, not a row somebody eventually notices',
    ).toHaveBeenCalledWith({ projectId: 'p-1', questionId: 'q-1' });
  });

  it('records the chosen option on the round it was answered on', async () => {
    releaseCommit();
    const out = await answer();
    expect(out.steps.at(-1)?.chosenOptionId).toBe('o-1');
    expect(out.steps.at(-1)?.answeredBy).toBe('u-1');
    expect(out.status).toBe('answered');
  });

  // cm:guard the ORDER, which a `toHaveBeenCalledWith` cannot see: a wake published before the row is durable sends the box to read an answer that is not there, and it then waits out the full sweep anyway — worse than not publishing, because the read comes back empty and looks authoritative.
  it('publishes nothing until the transaction resolves, not merely until its callback returns', async () => {
    const pending = answer();
    await Promise.resolve();
    await Promise.resolve();

    expect(update, 'the callback must have run — otherwise this proves nothing').toHaveBeenCalled();
    expect(
      wakeMastersForAnswer,
      'the statement has run and the transaction has not resolved: a wake here names an answer no commit has left behind',
    ).not.toHaveBeenCalled();

    releaseCommit();
    await pending;
    expect(wakeMastersForAnswer).toHaveBeenCalledTimes(1);
  });

  it('publishes nothing when the commit rejects', async () => {
    const pending = answer();
    await Promise.resolve();
    rejectCommit(new Error('deadlock detected'));

    await expect(pending).rejects.toThrow(/deadlock/);
    expect(
      wakeMastersForAnswer,
      'a rejected commit left no answer on the record, and a box woken for it reads nothing and stops waiting',
    ).not.toHaveBeenCalled();
  });
});

describe('a refusal writes nothing and wakes nobody', () => {
  const cases: Array<[string, () => void, Partial<Parameters<typeof answerQuestion>[0]>, RegExp]> =
    [
      [
        'the question is already answered',
        () => {
          row.status = 'answered';
        },
        {},
        /is answered/,
      ],
      [
        'the question was voided',
        () => {
          row.status = 'void';
        },
        {},
        /is void/,
      ],
      [
        'the question expired',
        () => {
          row.status = 'expired';
        },
        {},
        /is expired/,
      ],
      [
        'the park deadline has passed',
        () => {
          row.parkDeadlineAt = new Date(Date.now() - 1000);
        },
        {},
        /park deadline passed/,
      ],
      ['the round has moved on', () => {}, { round: 2 }, /round 2 and the question is on round 1/],
      ['the option is not on this round', () => {}, { optionId: 'o-9' }, /o-9 is not on round 1/],
      [
        'the option needs an authority this caller lacks',
        () => {},
        { optionId: 'o-2' },
        /authority admin/,
      ],
      ['the caller holds no role at all', () => {}, { role: null }, /authority writer/],
      ['the caller is a viewer', () => {}, { role: 'viewer' }, /authority writer/],
    ];

  for (const [name, plant, over, message] of cases) {
    it(`refuses by name when ${name}`, async () => {
      plant();
      const before = JSON.stringify(row.steps);

      await expect(answer(over)).rejects.toThrow(QuestionRefused);
      await expect(answer(over)).rejects.toThrow(message);

      expect(
        update,
        'a refusal that still issued the UPDATE is the defect, not the check',
      ).not.toHaveBeenCalled();
      expect(
        wakeMastersForAnswer,
        'a wake for an answer that was refused sends every box to read a row nothing changed',
      ).not.toHaveBeenCalled();
      expect(
        JSON.stringify(row.steps),
        'the refusal mutated the loaded row, so the same object handed to a retry would carry a half-written answer',
      ).toBe(before);
    });
  }

  // cm:guard the EQUALITY case, which no wall-clock plant can reach: `<` rather than `<=` in the deadline check passes every other case in this file and lets exactly the answer that arrived on the deadline through (ISS-980 criterion 29).
  it('refuses an answer arriving exactly on the park deadline', async () => {
    vi.useFakeTimers();
    try {
      const at = new Date('2026-09-11T12:00:00.000Z');
      vi.setSystemTime(at);
      row.parkDeadlineAt = new Date(at.getTime());

      await expect(answer()).rejects.toThrow(/park deadline passed at 2026-09-11T12:00:00.000Z/);
      expect(update).not.toHaveBeenCalled();
      expect(wakeMastersForAnswer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
