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

// ISS-572 (FB-153): a credential label followed by a count reads as prose. A count is one to three
// digits; four or more is a PIN's length and stays a credential, as a mixed or symbol value does.
describe('a count after a credential label is prose', () => {
  it.each([
    'no token: 4 failures',
    '3 tests failed, token: 2 left',
    'secret: 12 rows',
    'password: 999 attempts',
    '{"token": 7}',
  ])('admits a label followed by a count: %s', (text) => {
    expect(scrubLogText(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });

  it.each([
    ['a word with a digit', 'password: hunter2', `password: ${FILTERED}`],
    ['a PIN-length number', 'pin token: 4821', `pin token: ${FILTERED}`],
    ['a long number', 'secret: 90417263', `secret: ${FILTERED}`],
    ['a digit glued to a letter', 'token: 4a', `token: ${FILTERED}`],
    ['a signed number', 'password: -12', `password: ${FILTERED}`],
    ['a mixed-case value', 'api_key: zQ8kWx', `api_key: ${FILTERED}`],
    ['a symbol value', 'token: 12.5', `token: ${FILTERED}`],
  ])('still refuses %s', (_shape, text, scrubbed) => {
    expect(scrubLogText(text)).toBe(scrubbed);
    expect(containsSecret(text)).toBe(true);
  });

  it('reads a label with its value cut off by the count rule too', () => {
    expect(containsSecret('password: 3 tries left')).toBe(false);
    expect(containsSecret('password: 3141')).toBe(true);
  });
});
