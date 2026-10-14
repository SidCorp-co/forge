import { describe, expect, it } from 'vitest';
import { sentence } from './prose.js';

describe('sentence', () => {
  it.each([
    ['a pairing code', 'A pairing code.'],
    ['already a sentence.', 'Already a sentence.'],
    ['a question?', 'A question?'],
    ['  padded  ', 'Padded.'],
    ['204 while pending', '204 while pending.'],
  ])('writes %j as %j', (fragment, written) => {
    expect(sentence(fragment)).toBe(written);
  });

  it('writes nothing for nothing, so an empty note never prints a lone full stop', () => {
    expect(sentence('  ')).toBe('');
  });
});
