// A field a secret is named by (`api_key`, `password`, `token`) is a secret only where its value has
// a credential's shape, as a bearer token is told from prose (ISS-439): adminhub-fe ISS-16's verdict
// reason said "api_key: head" — the header a request carries the key in — and was refused
// VERDICT_SECRET, because every screen that refuses a secret asks this scrubber.

import { describe, expect, it } from 'vitest';
import { containsSecret, FILTERED, scrubLogText, secretSpans } from './index.js';

describe('a credential field is told from prose by its value', () => {
  it.each([
    'the request sends api_key: head, and the server reads it there',
    'apiKey: missing',
    'password: required',
    'token = none',
    'secret: not-set',
  ])('admits a field followed by an ordinary word: %s', (text) => {
    expect(scrubLogText(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });

  it.each([
    ['a digit', 'password: hunter2', `password: ${FILTERED}`],
    ['a capital after a small letter', 'api_key: abcDefGhij', `api_key: ${FILTERED}`],
    ['a character outside a word', 'token=a.b.c', `token=${FILTERED}`],
    ['24 characters', `secret: ${'q'.repeat(24)}`, `secret: ${FILTERED}`],
    ['a JSON field', '{"apiKey":"k3y-value"}', `{"apiKey":"${FILTERED}"}`],
  ])('refuses a value with %s', (_shape, text, scrubbed) => {
    expect(scrubLogText(text)).toBe(scrubbed);
    expect(containsSecret(text)).toBe(true);
    expect(secretSpans(text).map((s) => s.shape)).toContain('credential field');
  });
});
