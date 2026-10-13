import { describe, expect, it } from 'vitest';
import type { PaneAsk } from '../jobs/blocked-wire.js';
import { screenAtDoor } from '../messaging/screen.js';
import { oneLine, paneQuestions, refusedPaneQuestion, rulesOf } from './pane-question.js';

const WHO = 'release agent';

function dialog(over: Partial<Extract<PaneAsk, { kind: 'dialog' }>['questions'][number]>): PaneAsk {
  return { kind: 'dialog', questions: [{ question: 'Q?', options: [], ...over }] };
}

/** What the tracker's own question screen says of each part of a carried question. */
function screened(asked: PaneAsk): boolean[] {
  return paneQuestions(asked, WHO).map(
    (q) =>
      screenAtDoor('question-ask', [
        q.prompt,
        ...(q.answer.shape === 'choice' ? q.answer.options.map((o) => o.label) : [q.answer.needed]),
      ]).ok,
  );
}

describe('a pane question', () => {
  it('is a choice with the pane options, the recommended one marked or else the first', () => {
    const [q] = paneQuestions(
      dialog({
        header: 'Fork',
        options: [{ label: 'Abort' }, { label: 'Ship', description: 'what is here (Recommended)' }],
      }),
      WHO,
    );
    expect(q?.prompt).toBe('Fork: Q?');
    expect(q?.answer).toMatchObject({ shape: 'choice', recommendedOptionId: 'o2' });
    const [plain] = paneQuestions(dialog({ options: [{ label: 'A' }, { label: 'B' }] }), WHO);
    expect(plain?.answer).toMatchObject({ recommendedOptionId: 'o1' });
  });

  it('is free text where there is nothing to choose between, or several may be chosen', () => {
    for (const q of [
      dialog({ options: [] }),
      dialog({ options: [{ label: 'Only' }] }),
      dialog({ options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }),
    ]) {
      expect(paneQuestions(q, WHO)[0]?.answer.shape).toBe('free_text');
    }
    expect(
      paneQuestions(
        dialog({ options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }),
        WHO,
      )[0]?.prompt,
    ).toContain('Options offered: A | B.');
  });

  it('is one question for each question of the dialog, in order', () => {
    const asked: PaneAsk = {
      kind: 'dialog',
      questions: [
        { question: 'First?', options: [] },
        { question: 'Second?', options: [] },
      ],
    };
    expect(paneQuestions(asked, WHO).map((q) => q.prompt)).toEqual(['First?', 'Second?']);
  });

  it('says what a permission stop and an unread stop could not be asked as', () => {
    const [permission] = paneQuestions({ kind: 'permission', tool: 'Bash', input: '{"a":1}' }, WHO);
    expect(permission?.prompt).toBe(
      'The release agent stopped to ask permission to use Bash: {"a":1}',
    );
    const [unread] = paneQuestions({ kind: 'unread', why: 'no transcript path is known' }, WHO);
    expect(unread?.prompt).toContain('could not read: no transcript path is known');
  });

  it('survives the question screen whatever the pane wrote', () => {
    const hostile: PaneAsk[] = [
      dialog({
        question: 'Line one\nline two',
        options: [{ label: '1. first' }, { label: '2) second' }],
      }),
      dialog({ question: '@all please look', options: [{ label: 'x\n3. y' }, { label: '@here' }] }),
      dialog({ question: '   ', options: [{ label: ' ' }, { label: '\n' }] }),
      dialog({ question: 'use token=abcd1234secretvalue then\nauthorization: Bearer abc.def' }),
      { kind: 'permission', tool: 'Bash', input: 'export API_KEY=sk-live-0123456789abcdef\n1. ok' },
    ];
    for (const asked of hostile)
      expect(screened(asked).every(Boolean), JSON.stringify(asked)).toBe(true);
  });

  it('carries no secret the pane wrote, and cuts what is too long', () => {
    const [q] = paneQuestions(dialog({ question: 'use password=hunter2hunter2 now' }), WHO);
    expect(q?.prompt).not.toContain('hunter2');
    expect(oneLine('x'.repeat(5000), 100)).toHaveLength(100);
    expect(oneLine('x'.repeat(5000), 100).endsWith('…')).toBe(true);
  });

  it('names the rules a refusal broke, each once, and carries the question as free text naming them', () => {
    expect(
      rulesOf('a\n  rule: single-line\n  shape: x\nb\n  rule: no-option-line\n  rule: single-line'),
    ).toEqual(['single-line', 'no-option-line']);
    const carried = refusedPaneQuestion(WHO, ['single-line']);
    expect(carried.prompt).toContain('(single-line)');
    expect(carried.answer.shape).toBe('free_text');
    expect(screenAtDoor('question-ask', [carried.prompt]).ok).toBe(true);
  });
});
