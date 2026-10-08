import { describe, expect, it } from 'vitest';
import { languageOfTag } from './language-tag.js';

describe('languageOfTag: the one rule a preference and a content language read through', () => {
  it('reads Vietnamese by the base language, in any case', () => {
    for (const tag of ['vi', 'vi-VN', 'VI', 'Vi-vn']) expect(languageOfTag(tag)).toBe('vi');
  });

  it('reads anything else, and no tag at all, as English', () => {
    for (const tag of ['en', 'en-GB', 'via', 'fr-VI', '', null, undefined]) {
      expect(languageOfTag(tag)).toBe('en');
    }
  });
});
