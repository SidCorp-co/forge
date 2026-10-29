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

// ISS-572 round 2 (judge K142, verdict e7d13e96): the count or word may close a sentence, a clause or
// a bracket. The marks that close it are prose and never part of the value, so a count still reads
// as a count; a value in a credential's shape is still a credential, and its closing bracket stays.
describe('a value that closes a sentence or a bracket', () => {
  it.each([
    'Three runs ended with no token: 4.',
    'no token: 4;',
    '(no token: 4)',
    '[no token: 4]',
    'no token: 4!',
    'no token: 4?',
    'no token: 4:',
    'secret: 12.',
    'The suite ran (no token: 4) and passed.',
    'it ended (secret: 12).',
    'password: required.',
    '(password: required)',
    'the field reads token: none;',
  ])('admits a count or a word followed by its closing marks: %s', (text) => {
    expect(scrubLogText(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
    expect(secretSpans(text)).toEqual([]);
  });

  it.each([
    ['a word with a digit and a full stop', 'password: hunter2.', `password: ${FILTERED}`],
    ['a PIN-length number and a full stop', 'token: 4821.', `token: ${FILTERED}`],
    ['a dotted number and a full stop', 'token: 1.5.', `token: ${FILTERED}`],
    ['a signed number and a semicolon', 'token: -5;', `token: ${FILTERED}`],
    ['a mixed-case value and a full stop', 'api_key: zQ8kWx.', `api_key: ${FILTERED}`],
    ['a symbol value and a full stop', 'secret: fake$val.', `secret: ${FILTERED}`],
    ['a word ending in a bang', 'password: Welcome!', `password: ${FILTERED}`],
    ['a word ending in a question mark', 'secret: whatever?', `secret: ${FILTERED}`],
    ['a value in a bracket', '(token: hunter2)', `(token: ${FILTERED})`],
    ['a value in a bracket ending a sentence', 'sent (password: hunter2).', `sent (password: ${FILTERED}).`],
    ['a PIN-length number in a square bracket', '[token: 4821]', `[token: ${FILTERED}]`],
  ])('still refuses %s, keeping a closing bracket', (_shape, text, scrubbed) => {
    expect(scrubLogText(text)).toBe(scrubbed);
    expect(containsSecret(text)).toBe(true);
    expect(secretSpans(text).map((s) => s.shape)).toContain('credential field');
  });

  it('scrubs a value of closing marks alone whole, and names it as the span', () => {
    const text = '(no token: )';
    expect(scrubLogText(text)).toBe(`(no token: ${FILTERED}`);
    expect(secretSpans(text).map((s) => text.slice(s.start, s.end))).toEqual([')']);
  });

  it('names the span without its closing bracket, where the scrubber replaced it', () => {
    const text = '(token: hunter2)';
    const [span] = secretSpans(text);
    expect(text.slice(span?.start, span?.end)).toBe('hunter2');
  });
});

describe('scrubbing a value that closes a bracket twice', () => {
  it.each(['(token: hunter2)', 'sent (password: hunter2).', `token=${FILTERED}`, 'token: a[b]'])(
    'changes nothing the second time: %s',
    (text) => {
      const once = scrubLogText(text);
      expect(scrubLogText(once)).toBe(once);
    },
  );
});
