import { describe, expect, it } from 'vitest';
import { SCOPE, WHERE, WHY } from './kinds.js';
import { SHAPE_HEAD, duplicateGap, duplicateRefusal, noticeFor, shapeRefusal } from './refusal.js';
import { readFiling } from './shape.js';

const SEEN = { key: 'ISS-42', title: 'The reader refuses a body with no rules' };
const OVERRIDE = 'confirmNotDuplicate';

describe('the refusal a filer meets', () => {
  it('is null where the filing has no gap, so nothing is said of a clean body', () => {
    const read = readFiling({
      title: 'A malformed filing is refused at the door',
      body: '# T\n\n## Outcome\n\nIt refuses the body here.\n\n## Rules\n\nThe rule is that it holds.\n\n## Out of scope\n\nNothing else moves at all.\n',
      category: 'feature',
    });
    expect(read.gaps).toEqual([]);
    expect(shapeRefusal(read)).toBeNull();
  });

  it('opens by saying the filing was held rather than filed', () => {
    const read = readFiling({ title: 'A title that reads fine', body: 'no headings here at all', category: 'feature' });
    expect(shapeRefusal(read)?.startsWith(SHAPE_HEAD)).toBe(true);
  });

  it('carries what was read, what the shape wants and the one command, on every gap', () => {
    const read = readFiling({ title: 'A title that reads fine', body: 'no headings here at all', category: 'feature' });
    const said = shapeRefusal(read) ?? '';
    for (const gap of read.gaps) {
      expect(said).toContain(`- read: ${gap.read}`);
      expect(said).toContain(`  wants: ${gap.wants}`);
      expect(said).toContain(`  clear: ${gap.clear}`);
    }
    expect(read.gaps.length).toBe(3);
  });

  it('renders one line per gap and no more', () => {
    const read = readFiling({ title: 'A title that reads fine', body: 'no headings here at all', category: 'feature' });
    expect((shapeRefusal(read) ?? '').match(/- read: /g)).toHaveLength(read.gaps.length);
  });
});

describe('the duplicate refusal', () => {
  it('names the key it matched', () => {
    expect(duplicateGap(SEEN, OVERRIDE).read).toContain('ISS-42');
  });

  it('names the title it matched, so a filer can see what it was measured against', () => {
    expect(duplicateGap(SEEN, OVERRIDE).read).toContain(SEEN.title);
  });

  it('names the flag that clears it, rather than a sentence nothing reads', () => {
    expect(duplicateGap(SEEN, OVERRIDE).clear).toContain(`send the filing again with \`${OVERRIDE}\``);
  });

  it('takes the flag name from its caller, so the door and the refusal cannot drift apart', () => {
    expect(duplicateGap(SEEN, 'somethingElse').clear).toContain('`somethingElse`');
    expect(duplicateGap(SEEN, 'somethingElse').clear).not.toContain('confirmNotDuplicate');
  });

  it('is classed as a duplicate and not as a section', () => {
    expect(duplicateGap(SEEN, OVERRIDE).because).toBe('duplicate');
  });

  it('renders under the same head as every other refusal', () => {
    expect(duplicateRefusal(SEEN, OVERRIDE).startsWith(SHAPE_HEAD)).toBe(true);
  });
});

describe('the notice a filed body earns', () => {
  it('is null where nothing was left out', () => {
    expect(noticeFor({ kind: 'feature', left: [] })).toBeNull();
  });

  it('names the section that was left out', () => {
    expect(noticeFor({ kind: 'feature', left: [WHY] })).toContain('It leaves out Why');
  });

  it('says what the body was read as', () => {
    expect(noticeFor({ kind: 'bug', left: [WHERE] })).toContain('Read as a bug.');
  });

  it('takes the article from the kind it names', () => {
    expect(noticeFor({ kind: 'enhancement', left: [WHY] })).toContain('Read as an enhancement.');
  });

  it('says outright that nothing was refused for it', () => {
    expect(noticeFor({ kind: 'feature', left: [WHY] })).toContain('refused on nothing');
  });

  it('lists several, in the order the table holds them', () => {
    expect(noticeFor({ kind: 'feature', left: [WHY, SCOPE] })).toContain('Why, Out of scope');
  });
});
