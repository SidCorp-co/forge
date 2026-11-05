/**
 * ISS-1017 — what the repository says of a commit a mark names is the mark's reading, never its
 * refusal: found, not found, not on the target, not this issue's, or unread, each with the code and
 * the words the read gave.
 *
 * @direct-test-of packages/core/src/issues/commit-landing.ts
 * @direct-test-of packages/core/src/issues/mark-said.ts
 */

import { describe, expect, it } from 'vitest';
import { commitReadingOf } from './commit-landing.js';
import { saidOf, saidSentence } from './mark-said.js';

const SHA = 'c0ffee'.repeat(6).concat('abcd');

describe('a commit read for a mark becomes a reading (outcome 2)', () => {
  it('reads found where the repository holds it as the issue’s on the target', () => {
    const reading = commitReadingOf(SHA, {
      ok: true,
      sha: SHA,
      committedAt: new Date('2026-11-05T00:00:00Z'),
      branch: 'main',
      repository: 'acme/epod',
      by: 'subject',
      filing: null,
    });
    expect(reading).toEqual({
      commit: SHA,
      outcome: 'found',
      branch: 'main',
      repository: 'acme/epod',
      by: 'subject',
    });
    expect(saidSentence({ commit: SHA }, reading)).toContain('acme/epod holds commit');
  });

  it.each([
    ['COMMIT_NOT_IN_REPOSITORY', 'not_found'],
    ['COMMIT_NOT_LANDED', 'not_on_target'],
    ['COMMIT_NOT_THIS_ISSUE', 'not_this_issue'],
    ['COMMIT_UNVERIFIED', 'unread'],
  ] as const)('reads %s as %s, keeping the code and the words', (code, outcome) => {
    const reading = commitReadingOf(SHA, { ok: false, code, detail: `said ${code}` });
    expect(reading).toEqual({ commit: SHA, outcome, code, detail: `said ${code}` });
    const sentence = saidSentence({ commit: SHA }, reading);
    expect(sentence).toContain(`${outcome}, ${code}: said ${code}`);
    expect(sentence).toContain('refuses nothing');
  });
});

describe('what a mark named is recorded as named (outcome 1)', () => {
  it('keeps each field the call sent and nothing it did not', () => {
    const said = saidOf({
      target: 'main',
      artifacts: [{ surface: 'ui', ref: 'docs/cli', change: 'added' }],
      liveReading: { url: 'https://docs.example.test/cli', status: 200 },
      note: 'read live',
    });
    expect(said).toEqual({
      target: 'main',
      artifacts: [{ surface: 'ui', ref: 'docs/cli', change: 'added' }],
      liveReading: { url: 'https://docs.example.test/cli', status: 200 },
      note: 'read live',
    });
    expect(saidSentence(said, null)).toContain(
      'a live reading of https://docs.example.test/cli answering 200',
    );
  });

  it('says a mark naming nothing names nothing', () => {
    expect(saidOf({})).toEqual({});
    expect(saidSentence({}, null)).toContain('names no evidence');
  });
});
