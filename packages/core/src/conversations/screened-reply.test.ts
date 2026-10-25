// ISS-1229 r41, judge-115 at 119c164: the room posted "- (nothing to add)" because the silence check read only text
// that starts with the phrase, and a short reply came back as one bullet point ("- Agreed.") and was drawn as a list.

import { describe, expect, it } from 'vitest';
import { declinedTail, declinedTurn, oneItemAsSentence } from './screened-reply.js';

describe('declinedTurn reads a reply as a person would', () => {
  it.each([
    '(nothing to add)',
    '- (nothing to add)',
    '* (Nothing to add)',
    '• (nothing to add).',
    '1. (nothing to add)',
    '> (nothing to add)',
    '> **(nothing to add)**',
    '_(nothing to add)_',
    '  -   (nothing to add) — all good',
  ])('declines %j', (reply) => {
    expect(declinedTurn(reply)).toBe(true);
  });

  it.each(['Nothing to add here, but ISS-4 moved.', '- Agreed.', 'I have (nothing to add)', ''])(
    'answers %j',
    (reply) => {
      expect(declinedTurn(reply)).toBe(false);
    },
  );

  it('keeps what the model wrote after the sentinel, past the marks, for the log', () => {
    expect(declinedTail('- **(nothing to add)** — thanks')).toBe('thanks');
    expect(declinedTail('> (nothing to add)')).toBe('');
  });
});

describe('oneItemAsSentence', () => {
  it.each([
    ['- Agreed.', 'Agreed.'],
    ['* Noted, ISS-1 stays in draft.', 'Noted, ISS-1 stays in draft.'],
    ['  + Agreed.\n\nISS-1 stays where it is.', 'Agreed.\n\nISS-1 stays where it is.'],
    ['• (nothing to add)', '(nothing to add)'],
  ])('posts the one bulleted item %j as its sentence', (reply, sentence) => {
    expect(oneItemAsSentence(reply)).toBe(sentence);
  });

  it.each([
    'Agreed.',
    '- ISS-1 is in draft.\n- ISS-2 is closed.',
    '1. Agreed.',
    '> Agreed.',
    '* * *',
    'Two things:\n- one',
    '- Agreed.\n- 🚀',
    '- Agreed.\n      - nested detail',
    '- Agreed.\n1. Then this.',
    '- Agreed.\n-',
  ])('keeps %j as written', (reply) => {
    expect(oneItemAsSentence(reply)).toBe(reply);
  });
});
