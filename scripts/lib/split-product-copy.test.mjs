// @direct-test-of scripts/split-product-copy.mjs
//
// The copy split names a home for every key prefix. A home whose copy file is gone (ISS-1071 deleted
// `copy/questions.json`) would be recreated by a carry, out of the list `copy-files.ts` reads, so its
// keys go unread in silence: every home the table names is a copy file on disk, and a carry over a
// gone one, or an edit in a language other than English, is refused by name.

import { describe, expect, it } from 'vitest';
import { goneHomes, PREFIX_HOMES, readCopyFiles, refusalsOf } from '../split-product-copy.mjs';

describe('the copy split', () => {
  it('names no home that is not a copy file on disk', () => {
    expect(goneHomes(readCopyFiles())).toEqual([]);
    expect(PREFIX_HOMES).not.toHaveProperty('questions');
  });

  it('names a home whose copy file is gone, with the prefixes pointing at it', () => {
    const files = { 'lib/i18n/copy/issues.json': { en: {} } };
    const homes = {
      issues: 'lib/i18n/copy/issues.json',
      questions: 'lib/i18n/copy/questions.json',
    };
    expect(goneHomes(files, homes)).toEqual(['lib/i18n/copy/questions.json (questions)']);
  });

  it('refuses a carry over a gone home and an edit in another language, by name', () => {
    const files = { 'lib/i18n/copy/issues.json': { en: {} } };
    const homes = {
      issues: 'lib/i18n/copy/issues.json',
      questions: 'lib/i18n/copy/questions.json',
    };
    const refusals = refusalsOf(
      [
        { lang: 'en', key: 'issues.title', before: undefined, after: 'Issues' },
        { lang: 'vi', key: 'issues.title', before: undefined, after: 'Vấn đề' },
      ],
      files,
      homes,
    );
    expect(refusals.join('\n')).toContain('lib/i18n/copy/questions.json (questions)');
    expect(refusals.join('\n')).toContain('vi issues.title');
    expect(
      refusalsOf([{ lang: 'en', key: 'issues.title', before: undefined, after: 'Issues' }], files, {
        issues: 'lib/i18n/copy/issues.json',
      }),
    ).toEqual([]);
  });
});
