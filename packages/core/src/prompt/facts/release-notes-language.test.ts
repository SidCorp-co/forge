import { describe, expect, it } from 'vitest';
import { renderFact } from './registry.js';

describe('the release-notes shape names the language the note is written in', () => {
  it('names Vietnamese for a vi project', () => {
    const text = renderFact('release-notes-format', { stage: 'drive', contentLanguage: 'vi' });
    expect(text).toContain('Vietnamese (`vi`)');
  });
  it('points at the content-language block where no project is in hand', () => {
    expect(renderFact('release-notes-format')).toContain('`## Content language` block names it');
  });
});
