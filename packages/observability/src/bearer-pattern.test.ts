// The scrubber reads a bearer token by its shape, never the English word after `Bearer` (ISS-439:
// "a Bearer credential" was refused as a secret in a judge's reopen reason and a review comment,
// because every screen that refuses a secret asks this scrubber).

import { describe, expect, it } from 'vitest';
import { containsSecret, scrubLogText } from './index.js';

describe('a bearer token is told from prose by its shape', () => {
  it.each([
    'The door admits a Bearer credential through an aliased import.',
    'a bearer compared with timingSafeEqual against a static secret',
    'Bearer authentication is what requireAuth reads.',
    'BEARER tokens are PATs here',
  ])('admits prose: %s', (text) => {
    expect(scrubLogText(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });

  it.each([
    ['a digit', 'sent Bearer s3cretvalue', 'sent Bearer [Filtered]'],
    ['a capital after a small letter', 'sent Bearer abcDefGhijk', 'sent Bearer [Filtered]'],
    ['24 characters', `Bearer ${'q'.repeat(24)} next`, 'Bearer [Filtered] next'],
    ['base64url with dots', 'bearer aB.cd-ef_09~xy', 'bearer [Filtered]'],
  ])('scrubs a token with %s', (_shape, text, scrubbed) => {
    expect(scrubLogText(text)).toBe(scrubbed);
    expect(containsSecret(text)).toBe(true);
  });

  it('keeps a token shorter than eight characters, as before', () => {
    expect(scrubLogText('Bearer a1b2c3')).toBe('Bearer a1b2c3');
  });
});
