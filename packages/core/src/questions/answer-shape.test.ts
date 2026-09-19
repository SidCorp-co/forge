import { describe, expect, it, vi } from 'vitest';
import {
  type ChoiceStep,
  chosenOptionIdOf,
  type FreeTextStep,
  isChoiceStep,
  type QuestionStep,
} from '../db/schema-questions.js';

vi.mock('../ws/master-wake.js', () => ({ wakeMastersForAnswer: async () => ({}) }));

let row: {
  id: string;
  projectId: string;
  status: string;
  steps: QuestionStep[];
  parkDeadlineAt: Date | null;
};
vi.mock('../db/client.js', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({ where: () => ({ limit: () => ({ for: async () => [row] }) }) }),
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      }),
  },
}));

const { answerQuestion, checkAnswer, mayAnswerFreeText, QuestionRefused } = await import(
  './write.js'
);

const anOption = {
  id: 'o-1',
  label: 'Take it',
  authority: 'writer',
  bindsTo: 'session',
  executedBy: 'agent',
} as const;

const choice: ChoiceStep = {
  round: 1,
  prompt: 'Which way?',
  askedAt: '2026-09-13T00:00:00.000Z',
  answerShape: 'choice',
  options: [anOption],
  recommendedOptionId: 'o-1',
};

const freeText: FreeTextStep = {
  round: 1,
  prompt: 'Which reading did you mean?',
  askedAt: '2026-09-13T00:00:00.000Z',
  answerShape: 'free_text',
  needed: 'the sentence you meant, in your own words',
};

describe('a round declares one answer shape', () => {
  it('refuses a free-text round that does not say what would settle it', () => {
    try {
      checkAnswer({ shape: 'free_text', needed: '   ' });
      throw new Error('the refusal did not happen');
    } catch (e) {
      expect(e).toBeInstanceOf(QuestionRefused);
      expect(
        (e as InstanceType<typeof QuestionRefused>).code,
        'a round that states no settlement asks the person to guess what counts as an answer, which is the one thing the option list never made them do',
      ).toBe('QUESTION_SHAPE_INVALID');
    }
  });

  it('accepts a free-text round that states it', () => {
    expect(() => checkAnswer({ shape: 'free_text', needed: 'the API token' })).not.toThrow();
  });

  it('still refuses a choice round with no recommended option', () => {
    expect(() =>
      checkAnswer({ shape: 'choice', options: [anOption], recommendedOptionId: '' }),
    ).toThrow(/recommended/i);
  });
});

describe('reading a step', () => {
  it('tells the two shapes apart', () => {
    expect(isChoiceStep(choice)).toBe(true);
    expect(isChoiceStep(freeText)).toBe(false);
  });

  it('reads a round stored before the tag existed as a choice', () => {
    const stored = {
      round: 1,
      prompt: 'Which way?',
      askedAt: '2026-09-01T00:00:00.000Z',
      options: [anOption],
      recommendedOptionId: 'o-1',
    } as unknown as QuestionStep;
    expect(isChoiceStep(stored)).toBe(true);
    expect(chosenOptionIdOf(stored)).toBeNull();
  });

  it('answers null for the chosen option of a free-text round', () => {
    expect(chosenOptionIdOf(freeText)).toBeNull();
    expect(chosenOptionIdOf({ ...choice, chosenOptionId: 'o-1' })).toBe('o-1');
    expect(chosenOptionIdOf(undefined)).toBeNull();
  });
});

describe('who may answer in words', () => {
  it('admits every role on the project and refuses only a stranger', () => {
    expect(mayAnswerFreeText('admin')).toBe(true);
    expect(mayAnswerFreeText('member')).toBe(true);
    expect(mayAnswerFreeText('viewer')).toBe(true);
    expect(mayAnswerFreeText(null)).toBe(false);
  });
});

async function refusalOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof QuestionRefused) return e.code;
    throw e;
  }
  throw new Error('the refusal did not happen');
}

describe('neither shape absorbs the other', () => {
  const openRow = (steps: QuestionStep[]) => ({
    id: 'q-1',
    projectId: 'p-1',
    status: 'open',
    steps,
    parkDeadlineAt: null,
  });

  it('refuses text handed to a choice round rather than matching it to an option', async () => {
    row = openRow([choice]);
    expect(
      await refusalOf(() =>
        answerQuestion({
          questionId: 'q-1',
          answer: { kind: 'text', text: 'take it' },
          round: 1,
          by: 'u-1',
          role: 'admin',
        }),
      ),
      'resolving prose to the nearest option is the guess a locked option and a fingerprint exist to prevent',
    ).toBe('QUESTION_ANSWER_WRONG_SHAPE');
  });

  it('refuses an option id handed to a free-text round', async () => {
    row = openRow([freeText]);
    expect(
      await refusalOf(() =>
        answerQuestion({
          questionId: 'q-1',
          answer: { kind: 'option', optionId: 'o-1' },
          round: 1,
          by: 'u-1',
          role: 'admin',
        }),
      ),
    ).toBe('QUESTION_ANSWER_WRONG_SHAPE');
  });

  it('refuses an empty text answer rather than recording one', async () => {
    row = openRow([freeText]);
    expect(
      await refusalOf(() =>
        answerQuestion({
          questionId: 'q-1',
          answer: { kind: 'text', text: '   ' },
          round: 1,
          by: 'u-1',
          role: 'admin',
        }),
      ),
    ).toBe('QUESTION_ANSWER_WRONG_SHAPE');
  });

  it('refuses a caller holding no role at all', async () => {
    row = openRow([freeText]);
    expect(
      await refusalOf(() =>
        answerQuestion({
          questionId: 'q-1',
          answer: { kind: 'text', text: 'the second reading' },
          round: 1,
          by: 'u-1',
          role: null,
        }),
      ),
    ).toBe('QUESTION_AUTHORITY_REQUIRED');
  });

  it('records the text, trimmed, and leaves no chosen option behind', async () => {
    row = openRow([freeText]);
    const out = await answerQuestion({
      questionId: 'q-1',
      answer: { kind: 'text', text: '  the second reading  ' },
      round: 1,
      by: 'u-1',
      role: 'member',
    });
    const last = out.steps.at(-1) as FreeTextStep;
    expect(last.answerText).toBe('the second reading');
    expect(last.answeredBy).toBe('u-1');
    expect(chosenOptionIdOf(last)).toBeNull();
  });
});
