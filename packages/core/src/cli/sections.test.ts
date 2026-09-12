import { describe, expect, it } from 'vitest';
import { OUTCOME, RULES, SCOPE } from './kinds.js';
import { hasLine, headingsOf, sectionIn } from './sections.js';

describe('reading a body into sections', () => {
  it('drops the body title, so a title sharing a section word cannot answer for the section', () => {
    const body = '# Outcome of the rewrite\n\n## Rules\n\nThe rule is that it holds.\n';
    expect(headingsOf(body)).toEqual(['Rules']);
    expect(sectionIn(body, OUTCOME.heading)).toBeNull();
  });

  it('keeps the first heading when it is not shallower than every other one', () => {
    const body = '## Outcome\n\nIt works after this.\n\n## Rules\n\nThe rule is that it holds.\n';
    expect(headingsOf(body)).toEqual(['Outcome', 'Rules']);
  });

  it('keeps a level-2 section that has level-3 subsections under it', () => {
    const body = '# Title\n\n## Rules\n\nThe rule is that it holds.\n\n### The first\n\nmore\n';
    expect(headingsOf(body)).toEqual(['Rules', 'The first']);
    expect(sectionIn(body, RULES.heading)?.under).toContain('The rule is that it holds.');
  });

  it('stops a section at the next heading of ANY depth, not the next of its own', () => {
    const body = '# Title\n\n## Rules\n\nkeep\n\n### deeper\n\ndrop\n';
    expect(sectionIn(body, RULES.heading)?.under).toContain('keep');
    expect(sectionIn(body, RULES.heading)?.under).not.toContain('drop');
  });

  it('matches a heading by family and not by its exact wording', () => {
    const body = '# Title\n\n## Business rules\n\nThe rule is that it holds.\n';
    expect(sectionIn(body, RULES.heading)?.heading).toBe('Business rules');
  });

  it('quotes the heading the body wrote, not the canonical one', () => {
    const body = '# Title\n\n## Acceptance\n\nIt has to hold under load.\n';
    expect(sectionIn(body, RULES.heading)?.heading).toBe('Acceptance');
  });

  it('returns null for a heading the body does not carry', () => {
    expect(sectionIn('# Title\n\n## Rules\n\nyes it does hold\n', SCOPE.heading)).toBeNull();
  });

  it('reads an empty section as present-but-empty rather than absent', () => {
    const found = sectionIn('# Title\n\n## Outcome\n\n## Rules\n\nit holds under load\n', OUTCOME.heading);
    expect(found).not.toBeNull();
    expect(found?.under.trim()).toBe('');
  });
});

describe('the substantial floor', () => {
  it('counts a line of four words as substantial', () => {
    expect(hasLine('one two three four')).toBe(true);
  });

  it('refuses a line of three words', () => {
    expect(hasLine('one two three')).toBe(false);
  });

  it('counts the words under a list marker, not the marker', () => {
    expect(hasLine('- one two three four')).toBe(true);
    expect(hasLine('- one two three')).toBe(false);
  });

  it('counts a numbered line the same way', () => {
    expect(hasLine('1. one two three four')).toBe(true);
  });

  it('takes any one line, not the first', () => {
    expect(hasLine('short\n\nthis line is long enough')).toBe(true);
  });

  it('refuses null, undefined and whitespace', () => {
    expect(hasLine(null)).toBe(false);
    expect(hasLine(undefined)).toBe(false);
    expect(hasLine('   \n  \n')).toBe(false);
  });
});
