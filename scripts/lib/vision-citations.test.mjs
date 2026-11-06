import { describe, expect, it } from 'vitest';
import { judgeVision, principlesOf, visionCitationsIn } from './vision-citations.mjs';

// Every citation below is assembled, never written whole: this file is itself scanned by
// check-doc-citations, and a literal planted citation here would turn the real gate red.
const V = 'VISION';
const cite = (name) => `${V}: ${name}`;

const vision = (principles) =>
  [
    '# Forge — Vision',
    '',
    `> Cite principles by name, never by number — \`${cite('state-never-lies')}\`.`,
    '',
    '## 3. Who',
    '',
    '1. **not-a-principle** — a numbered bold item in another section.',
    '',
    principles,
    '',
    '## 5. Boundaries',
    '',
    '1. **also-not-one** — after the section ends.',
  ].join('\n');

const PRINCIPLES = [
  '## 4. Principles',
  '',
  '### Custody and trust',
  '',
  '1. **trust-over-features** — correctness outranks breadth.',
  '2. **state-never-lies** — no transition without evidence;',
  '   no failure that is not observable.',
  '10. **kernel-hard-policy-soft** — mechanism and policy are separated.',
].join('\n');

const names = principlesOf(vision(PRINCIPLES)).names;

describe('principlesOf', () => {
  it('reads the bold names of the Principles section and of no other section', () => {
    expect(names).toEqual(['trust-over-features', 'state-never-lies', 'kernel-hard-policy-soft']);
  });

  it('reads an unnumbered Principles heading too', () => {
    expect(
      principlesOf(vision(PRINCIPLES.replace('## 4. Principles', '## Principles'))).names,
    ).toEqual(names);
  });

  it('refuses a VISION with no Principles section, naming the heading it looked for', () => {
    const read = principlesOf(vision(PRINCIPLES.replace('## 4. Principles', '## 4. Tenets')));
    expect(read.names).toBeUndefined();
    expect(read.error).toMatch(/no `## Principles` section/);
  });

  it('refuses a Principles section that yields no names rather than passing every citation', () => {
    const read = principlesOf(
      vision('## 4. Principles\n\n1. state-never-lies — not bold any more.'),
    );
    expect(read.names).toBeUndefined();
    expect(read.error).toMatch(/yields no names/);
  });

  it('refuses an empty file the same way, as the gate reads a missing VISION', () => {
    expect(principlesOf('').error).toMatch(/no `## Principles` section/);
  });

  it('refuses a name carried twice', () => {
    const read = principlesOf(vision(`${PRINCIPLES}\n11. **state-never-lies** — again.`));
    expect(read.error).toMatch(/names state-never-lies twice/);
  });
});

describe('visionCitationsIn', () => {
  it('reads a citation with backticks, without them, and in a code comment', () => {
    const doc = `A rule (\`${cite('state-never-lies')}\`) and ${cite('kernel-hard-policy-soft')}.`;
    const code = `// the record never guesses (${cite('trust-over-features')}).\nconst x = 1;`;
    expect(visionCitationsIn('a.md', doc).map((c) => c.name)).toEqual([
      'state-never-lies',
      'kernel-hard-policy-soft',
    ]);
    expect(visionCitationsIn('a.ts', code)).toEqual([
      { rel: 'a.ts', line: 1, token: cite('trust-over-features'), name: 'trust-over-features' },
    ]);
  });

  it('reads a citation wrapped onto the next comment line, in each comment style', () => {
    for (const lead of ['//', ' *', '--', '///', '#', '']) {
      const text = `first line\nsays why (${V}:\n${lead} state-never-lies). Then more.`;
      expect(visionCitationsIn('x', text)).toEqual([
        { rel: 'x', line: 2, token: cite('state-never-lies'), name: 'state-never-lies' },
      ]);
    }
  });

  it('reads a citation by number in each of its spellings', () => {
    const text = [`${V} №3`, `${V} §1 metric`, `${V} #12`, `${V}: §4`, `${V}.md §2`].join('\n');
    expect(visionCitationsIn('x', text).map((c) => [c.line, c.token, c.name])).toEqual([
      [1, `${V} №3`, null],
      [2, `${V} §1`, null],
      [3, `${V} #12`, null],
      [4, `${V} §4`, null],
      [5, `${V} §2`, null],
    ]);
  });

  it('reads the first word after the colon even when it is no principle, so prose in that shape is measured', () => {
    expect(visionCitationsIn('x', `(${V}: Forge never infers)`).map((c) => c.name)).toEqual([
      'Forge',
    ]);
  });

  it('does not read a path, a longer identifier or a template as a citation', () => {
    const text = [
      `\`docs/${V}.md:principlesOf\``,
      `MY_${V}: state-never-lies`,
      `SUPER${V}: x`,
      `\`${V}: <name>\``,
      `${V} №n`,
      `the ${V} document`,
    ].join('\n');
    expect(visionCitationsIn('x', text)).toEqual([]);
  });
});

describe('judgeVision', () => {
  const judge = (text) => judgeVision(visionCitationsIn('f.md', text), names);

  it('passes every citation whose name VISION carries', () => {
    expect(judge(`${cite('state-never-lies')} and \`${cite('trust-over-features')}\``)).toEqual({
      unknown: [],
      byNumber: [],
    });
  });

  it('fails a name VISION does not carry, naming the file, line and token', () => {
    const { unknown, byNumber } = judge(
      `ok ${cite('state-never-lies')}\n\`${cite('no-such-principle')}\``,
    );
    expect(byNumber).toEqual([]);
    expect(unknown).toEqual([
      { rel: 'f.md', line: 2, token: cite('no-such-principle'), name: 'no-such-principle' },
    ]);
  });

  it('fails a principle renamed in VISION at every citation of its old name', () => {
    const renamed = principlesOf(
      vision(PRINCIPLES.replace('state-never-lies', 'state-is-evidenced')),
    ).names;
    const cited = visionCitationsIn(
      'f.ts',
      `// (${cite('state-never-lies')})\n// (${cite('state-never-lies')})`,
    );
    expect(judgeVision(cited, renamed).unknown.map((c) => c.line)).toEqual([1, 2]);
  });

  it('is case-sensitive: the identifier is the kebab-case name as written', () => {
    expect(judge(cite('State-Never-Lies')).unknown).toHaveLength(1);
  });

  it('fails a citation by number even where the number lands on a real principle', () => {
    const { unknown, byNumber } = judge(`${V} №3 is state-never-lies`);
    expect(unknown).toEqual([]);
    expect(byNumber.map((c) => c.token)).toEqual([`${V} №3`]);
  });
});
