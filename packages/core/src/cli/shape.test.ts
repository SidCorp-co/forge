import { describe, expect, it } from 'vitest';
import { KINDS, type KindShape } from './kinds.js';
import { partsIn, readFiling, twoChangesIn } from './shape.js';

const TITLE = 'the layer refuses a body missing a section its kind requires';

function bodyFor(shape: KindShape, without: string | null = null): string {
  return shape.needs
    .filter((one) => one.title !== without)
    .map((one) => `## ${one.title}\n\nthis line holds the ${one.title} section`)
    .join('\n\n');
}

function read(shape: KindShape, without: string | null = null) {
  return readFiling({ title: TITLE, body: bodyFor(shape, without), category: shape.kind });
}

describe('a body carrying every section its kind requires', () => {
  it.each(KINDS.map((one) => [one.kind, one] as const))(
    '%s is read with no gap',
    (_kind, shape) => {
      expect(read(shape).gaps).toEqual([]);
    },
  );
});

// cm:guard the case is built by REMOVING one section from a body that was just asserted complete — a hand-written "incomplete" body can be refused for a second reason, and then the assertion passes without the rule under test ever firing
describe('every required section has a case that goes red when only it is removed', () => {
  const cases = KINDS.flatMap((shape) =>
    shape.needs.map(
      (section) => [`${shape.kind} without ${section.title}`, shape, section] as const,
    ),
  );

  it.each(cases)('%s is refused, naming that section', (_name, shape, section) => {
    const gaps = read(shape, section.title).gaps;
    expect(gaps).toHaveLength(1);
    const only = gaps[0];
    expect(only?.read).toContain(section.reads);
    expect(only?.wants).toContain(section.wants);
    expect(only?.clear).toContain(`## ${section.title}`);
  });
});

describe('what the refusal for a missing section says', () => {
  const gap = read(KINDS[2] as KindShape, 'Outcome').gaps[0];

  it('says what was read of the body there, naming the headings it did find', () => {
    expect(gap?.read).toContain('no heading naming the outcome');
    expect(gap?.read).toContain('`Rules`');
    expect(gap?.read).toContain('`Out of scope`');
  });

  it('says what the shape wants, and of which kind', () => {
    expect(gap?.wants).toContain('a heading naming the outcome');
    expect(gap?.wants).toContain('required of a feature');
  });

  it('names the one thing that clears it', () => {
    expect(gap?.clear).toBe('add `## Outcome` and send the filing again');
  });

  it('quotes the thin heading already there rather than the section title', () => {
    const body = `${bodyFor(KINDS[2] as KindShape, 'Outcome')}\n\n## The outcome we want\n`;
    const thin = readFiling({ title: TITLE, body, category: 'feature' }).gaps[0];
    expect(thin?.read).toContain('`The outcome we want`');
    expect(thin?.clear).toContain('under the heading `The outcome we want` already there');
  });
});

describe('the gaps that are read before any section is', () => {
  it('an empty body is refused with no section named', () => {
    const reading = readFiling({ title: TITLE, body: '   \n\n', category: 'feature' });
    expect(reading.gaps).toHaveLength(1);
    expect(reading.gaps[0]?.read).toContain('no text in them');
    expect(reading.gaps[0]?.wants).not.toContain('required of');
  });

  it('a category this layer does not define is refused, and no section is read under it', () => {
    const reading = readFiling({
      title: TITLE,
      body: bodyFor(KINDS[2] as KindShape, 'Outcome'),
      category: 'chore',
    });
    expect(reading.gaps).toHaveLength(1);
    expect(reading.gaps[0]?.read).toContain('`chore`');
    for (const kind of ['bug', 'enhancement', 'feature', 'review']) {
      expect(reading.gaps[0]?.wants).toContain(kind);
    }
  });
});

describe('the gaps a title decides', () => {
  const gapsFor = (title: string) =>
    readFiling({ title, body: bodyFor(KINDS[2] as KindShape), category: 'feature' }).gaps;

  it('a title of a single word is refused', () => {
    expect(gapsFor('Fix')[0]?.wants).toContain('not one word');
  });

  it('a title of work verbs and carrier words alone is refused', () => {
    expect(gapsFor('update and fix it')[0]?.wants).toContain('a work verb alone never says');
  });

  it('a title carrying a file path is refused', () => {
    const gaps = gapsFor('the reader in packages/core/src/cli/shape.ts stops guessing');
    expect(gaps[0]?.read).toContain('a file path in the title');
  });

  it('a title naming the behaviour is not refused', () => {
    expect(gapsFor(TITLE)).toEqual([]);
  });
});

describe('one sentence asking for two changes', () => {
  const SPLIT = '`forge new` must refuse a thin body and `forge issue` should list the open ones.';

  it('is found only when each side names a different thing', () => {
    expect(twoChangesIn(SPLIT)?.named).toEqual(['forge new', 'forge issue']);
    expect(twoChangesIn('`forge new` must refuse a thin body and should say why.')).toBeNull();
    expect(
      twoChangesIn('`forge new` refuses a thin body and `forge issue` lists them.'),
    ).toBeNull();
  });

  it('is refused with both things that sentence asks for named', () => {
    const body = `${bodyFor(KINDS[2] as KindShape)}\n\n${SPLIT}`;
    const gap = readFiling({ title: TITLE, body, category: 'feature' }).gaps[0];
    expect(gap?.read).toContain('two changes');
    expect(gap?.wants).toContain('forge new');
    expect(gap?.wants).toContain('forge issue');
  });
});

describe('a body claiming its own parts in prose', () => {
  it('is found only where the phrase governs the keys', () => {
    expect(partsIn('The parts are ISS-11 and ISS-12.')?.keys).toEqual(['ISS-11', 'ISS-12']);
    expect(partsIn('ISS-11 and ISS-12 both mention the same parts.')).toBeNull();
  });

  it('is refused with the keys it claimed named', () => {
    const body = `${bodyFor(KINDS[2] as KindShape)}\n\nThe parts are ISS-11 and ISS-12.`;
    const gap = readFiling({ title: TITLE, body, category: 'feature' }).gaps[0];
    expect(gap?.read).toContain('ISS-11 and ISS-12');
    expect(gap?.clear).toContain('ISS-11, ISS-12');
  });
});

describe('a section a kind only suggests', () => {
  it('is filed rather than refused, and the answer names what was left out', () => {
    const reading = read(KINDS[2] as KindShape);
    expect(reading.gaps).toEqual([]);
    expect(reading.notice).toContain('Why');
    expect(reading.notice).toContain('refused on nothing');
  });

  it('earns no notice at all once the body carries it', () => {
    const body = `${bodyFor(KINDS[2] as KindShape)}\n\n## Why\n\nit is worth a round of the flow`;
    expect(readFiling({ title: TITLE, body, category: 'feature' }).notice).toBeNull();
  });
});
