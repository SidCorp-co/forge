import { describe, expect, it } from 'vitest';
import { KINDS, type CliSection } from './kinds.js';
import { categoryGap, partsIn, readFiling, titleGaps, twoChangesIn } from './shape.js';

const TITLE = 'A malformed filing is refused at the door';

/** One section, written so it clears the substantial floor on its own. */
function written(part: CliSection): string {
  return `## ${part.title}\n\nThis line says something real about ${part.bare} here.\n`;
}

/** A body carrying every section the kind owes and every one it merely suggests. */
function whole(kind: string): string {
  const shape = KINDS.find((one) => one.kind === kind);
  if (!shape) throw new Error(`no kind ${kind}`);
  return `# ${TITLE}\n\n${[...shape.needs, ...shape.says].map(written).join('\n')}`;
}

/** The same body with exactly one section cut out of it. */
function without(kind: string, part: CliSection): string {
  return whole(kind).replace(written(part), '');
}

function gapsFor(body: string, category: string | null, title = TITLE) {
  return readFiling({ title, body, category }).gaps;
}

describe('a whole body is read as whole', () => {
  for (const kind of KINDS) {
    it(`files ${kind.kind} with no gap when every section is there`, () => {
      expect(gapsFor(whole(kind.kind), kind.kind)).toEqual([]);
    });

    it(`reads ${kind.kind} against its own kind`, () => {
      expect(readFiling({ title: TITLE, body: whole(kind.kind), category: kind.kind }).kind?.kind).toBe(
        kind.kind,
      );
    });
  }
});

describe('every required section goes red when it alone is removed', () => {
  for (const kind of KINDS) {
    for (const part of kind.needs) {
      it(`refuses ${kind.kind} missing ${part.title}, naming it`, () => {
        const gaps = gapsFor(without(kind.kind, part), kind.kind);
        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.because).toBe('section');
        expect(gaps[0]?.read).toContain(part.reads);
        expect(gaps[0]?.wants).toContain(part.wants);
        expect(gaps[0]?.clear).toContain(`## ${part.title}`);
      });
    }
  }
});

describe('a section that is there but says nothing', () => {
  it('quotes the heading the body wrote and asks for a line under it', () => {
    const body = whole('feature').replace(
      '## Outcome\n\nThis line says something real about outcome here.\n',
      '## The outcome\n\nshort\n',
    );
    const gaps = gapsFor(body, 'feature');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.read).toContain('`The outcome` with nothing under it of 4 words or more');
    expect(gaps[0]?.clear).toContain('write one line of 4 words or more under the heading `The outcome`');
  });

  it('lets one sentence stand in for the out-of-scope heading and nothing else', () => {
    const body = whole('feature').replace(
      '## Out of scope\n\nThis line says something real about out-of-scope here.\n',
      'Nothing here is out of scope.\n',
    );
    expect(gapsFor(body, 'feature')).toEqual([]);
  });

  it('names every heading the body did carry, so a filer can see what was read', () => {
    const gaps = gapsFor('# A title\n\n## Notes\n\nthis body has one heading only\n', 'feature');
    expect(gaps[0]?.read).toContain('among `Notes`');
  });

  it('says so when the body carries no heading at all', () => {
    const gaps = gapsFor('just a paragraph with no heading anywhere in it', 'feature');
    expect(gaps[0]?.read).toContain('and the body has no heading at all');
  });
});

describe('an empty body', () => {
  it('is refused before any section is read', () => {
    const gaps = gapsFor('', 'feature');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.because).toBe('body');
  });

  it('is refused the same way when it is only whitespace', () => {
    expect(gapsFor('   \n\n  ', 'feature')[0]?.because).toBe('body');
  });

  it('is refused even where the category is undefined, the body being read first', () => {
    expect(gapsFor('', 'chore')[0]?.because).toBe('body');
  });
});

describe('the category, required at this door', () => {
  it('refuses a filing naming none', () => {
    const gaps = gapsFor(whole('feature'), null);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.because).toBe('category');
    expect(gaps[0]?.clear).toContain('bug, enhancement, feature, review');
  });

  it('refuses a category it does not define, naming the four', () => {
    const gaps = gapsFor(whole('feature'), 'chore');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.because).toBe('category');
    expect(gaps[0]?.read).toContain('`chore`, which this layer does not define');
    expect(gaps[0]?.clear).toContain('bug, enhancement, feature, review');
  });

  it('reads an empty string, and one of spaces, as naming none rather than as a typo', () => {
    expect(categoryGap('')?.clear).toContain('A filing needs a category');
    expect(categoryGap('   ')?.clear).toContain('A filing needs a category');
    expect(categoryGap(undefined)?.read).toBe('a filing naming no category');
    expect(categoryGap(null)?.read).toBe('a filing naming no category');
  });

  it('takes a category with space around it rather than refusing the space', () => {
    expect(categoryGap(' feature ')).toBeNull();
    expect(gapsFor(whole('feature'), ' feature ')).toEqual([]);
  });

  it('reads no section once the category is refused, so one gap comes back and not six', () => {
    expect(gapsFor('# A title\n\nnothing else at all here\n', 'chore')).toHaveLength(1);
  });

  it('passes a category it defines', () => {
    for (const kind of KINDS) expect(categoryGap(kind.kind)).toBeNull();
  });
});

describe('the title', () => {
  it('refuses one word', () => {
    expect(titleGaps('Broken')[0]?.wants).toContain('not one word');
  });

  it('accepts two words that say something', () => {
    expect(titleGaps('Filings are refused')).toEqual([]);
  });

  it('refuses a title made only of work verbs and carrier words', () => {
    expect(titleGaps('Update the fix')[0]?.wants).toContain('a work verb alone never says');
  });

  it('refuses a file path in the title', () => {
    const gaps = titleGaps('The reader in src/cli/shape.ts refuses it');
    expect(gaps.some((one) => one.read.includes('a file path in the title'))).toBe(true);
  });

  it('refuses a bare filename in the title', () => {
    expect(titleGaps('The reader in shape.ts refuses it')).toHaveLength(1);
  });

  it('reaches the filing through readFiling, not only on its own', () => {
    expect(gapsFor(whole('feature'), 'feature', 'Broken')[0]?.because).toBe('title');
  });
});

describe('one sentence asking for two changes', () => {
  it('is refused, naming both things it asks for', () => {
    const said = '`readFiling` should refuse it and `createIssue` must never see it.';
    const found = twoChangesIn(said);
    expect(found?.named).toEqual(['readFiling', 'createIssue']);
  });

  it('reaches the filing as a gap naming both', () => {
    const body = `${whole('feature')}\n\`readFiling\` should refuse it and \`createIssue\` must never see it.\n`;
    const gaps = gapsFor(body, 'feature');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.because).toBe('split');
    expect(gaps[0]?.wants).toContain('readFiling and createIssue');
  });

  it('stays quiet where both clauses name the same thing', () => {
    expect(twoChangesIn('`readFiling` should refuse it and `readFiling` must say why.')).toBeNull();
  });

  it('stays quiet where only one clause carries a modal', () => {
    expect(twoChangesIn('`readFiling` should refuse it and `createIssue` ran yesterday.')).toBeNull();
  });

  it('stays quiet where neither side names a thing', () => {
    expect(twoChangesIn('it should refuse this and it must also say why.')).toBeNull();
  });
});

describe('a body claiming its own parts in prose', () => {
  it('is refused, naming the keys it claimed', () => {
    expect(partsIn('Its parts are ISS-1 and ISS-2.')?.keys).toEqual(['ISS-1', 'ISS-2']);
  });

  it('reaches the filing as a gap naming the keys and how to relate them', () => {
    const gaps = gapsFor(`${whole('feature')}\nIts parts are ISS-1 and ISS-2.\n`, 'feature');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.because).toBe('parts');
    expect(gaps[0]?.read).toContain('ISS-1 and ISS-2');
    expect(gaps[0]?.clear).toContain('relate ISS-1, ISS-2');
  });

  it('stays quiet on a line that merely holds two keys', () => {
    expect(partsIn('ISS-1 and ISS-2 were both closed last week.')).toBeNull();
  });

  it('stays quiet on a bare "part" with no connective governing the keys', () => {
    expect(partsIn('a guide part ISS-1 (the lesson) and ISS-2')).toBeNull();
  });

  it('stays quiet where the phrase governs one key only', () => {
    expect(partsIn('Its parts are ISS-1.')).toBeNull();
  });

  it('reads a label between a key and its separator without taking it for a key', () => {
    expect(partsIn('It consists of ISS-1 (the reader) and ISS-2.')?.keys).toEqual(['ISS-1', 'ISS-2']);
  });
});

describe('the sections a kind only suggests', () => {
  it('are named as left out rather than refused', () => {
    const shape = KINDS.find((one) => one.kind === 'feature');
    const body = whole('feature').replace(written(shape?.says[0] as CliSection), '');
    const read = readFiling({ title: TITLE, body, category: 'feature' });
    expect(read.gaps).toEqual([]);
    expect(read.left.map((one) => one.title)).toEqual(['Why']);
  });

  it('are empty where the body carries them', () => {
    expect(readFiling({ title: TITLE, body: whole('bug'), category: 'bug' }).left).toEqual([]);
  });
});
