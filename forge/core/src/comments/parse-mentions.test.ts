import { describe, expect, it } from 'vitest';
import { parseMentions } from './parse-mentions.js';

describe('parseMentions', () => {
  it('extracts a single @handle', () => {
    expect(parseMentions('hi @alice can you check')).toEqual(['alice']);
  });

  it('extracts multiple distinct handles in order', () => {
    expect(parseMentions('cc @bob and @alice please')).toEqual(['bob', 'alice']);
  });

  it('deduplicates repeated handles', () => {
    expect(parseMentions('@alice and @alice again')).toEqual(['alice']);
  });

  it('lowercases handles', () => {
    expect(parseMentions('@Alice and @BOB')).toEqual(['alice', 'bob']);
  });

  it('returns [] when no @handle is present', () => {
    expect(parseMentions('plain message no handles')).toEqual([]);
  });

  it('skips handles inside email addresses', () => {
    // The `@host.com` here is preceded by a word-character, so should not be
    // captured as a mention.
    expect(parseMentions('reach me at user@host.com if needed')).toEqual([]);
  });

  it('captures @handle at start of body', () => {
    expect(parseMentions('@alice please look')).toEqual(['alice']);
  });

  it('handles dots, plus, hyphens, underscores in the local-part grammar', () => {
    expect(parseMentions('@alice.smith @bob+work @carol-lee @dave_q')).toEqual([
      'alice.smith',
      'bob+work',
      'carol-lee',
      'dave_q',
    ]);
  });

  it('does not capture lone @ symbol', () => {
    expect(parseMentions('email @ symbol alone')).toEqual([]);
  });

  it('strips trailing dot/hyphen punctuation from handles', () => {
    expect(parseMentions('cc @alice, @bob.')).toEqual(['alice', 'bob']);
  });

  it('preserves interior dots in handles', () => {
    expect(parseMentions('hello @alice.smith')).toEqual(['alice.smith']);
  });
});
