import { describe, expect, it } from 'vitest';
import { OUTCOME, SCOPE } from './kinds.js';
import { hasSubstantialLine, headingsOf, holds, sectionIn, sectionUnder } from './sections.js';

const TITLED = [
  '# Outcome',
  '',
  '## Rules',
  '',
  'the rule line here',
  '',
  '### A sub',
  '',
  'text',
].join('\n');

describe('reading a body into sections', () => {
  it("a body's own title line is the parent of its sections and never one of them", () => {
    expect(headingsOf(TITLED)).toEqual(['Rules', 'A sub']);
    expect(sectionIn(TITLED, OUTCOME.heading)).toBeNull();
  });

  it('a heading of the same depth as its neighbours is a section, title or not', () => {
    const flat = '## Outcome\n\nwhat is true after the change\n\n## Rules\n\nthe rule';
    expect(headingsOf(flat)).toEqual(['Outcome', 'Rules']);
    expect(sectionUnder(flat, OUTCOME.heading)?.trim()).toBe('what is true after the change');
  });

  it('the text under a heading stops at the next heading of any depth', () => {
    const body = '## Outcome\n\nmine\n\n### Deeper\n\nnot mine';
    expect(sectionUnder(body, OUTCOME.heading)).not.toContain('not mine');
  });

  it('a heading with nothing under it is no section', () => {
    expect(holds('## Outcome\n\n## Rules\n\nthe rule line', OUTCOME).ok).toBe(false);
    expect(holds('## Outcome\n\n## Rules\n\nthe rule line', OUTCOME).heading).toBe('Outcome');
  });

  it('a line under the substantial floor does not hold the section', () => {
    expect(hasSubstantialLine('three words only')).toBe(false);
    expect(hasSubstantialLine('- four words are enough')).toBe(true);
    expect(holds('## Outcome\n\ntoo short\n', OUTCOME).ok).toBe(false);
    expect(holds('## Outcome\n\nlong enough to count here\n', OUTCOME).ok).toBe(true);
  });

  it('the out-of-scope section may be spoken in a sentence instead of a heading', () => {
    expect(holds('Nothing here is out of scope.', SCOPE).ok).toBe(true);
    expect(holds('This body says no such thing.', SCOPE).ok).toBe(false);
  });
});
