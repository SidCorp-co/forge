/**
 * ISS-1329 — the capability page routes to guides core serves and says nothing a surface that
 * describes itself should say. Each rule below is exercised against a planted fault, so a green
 * run is a rule that can go red.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_AREAS,
  CAPABILITY_GUIDE,
  CAPABILITY_GUIDE_SLUG,
  type CapabilityArea,
} from './capability-guide.js';
import { CORPUS_SCOPE, cliServedBullets } from './corpus-scope.js';
import { FORGE_GUIDES, getGuide } from './registry.js';

/** `<area>: routes to <slug>, which core does not serve` for each unresolved route. */
function routeFaults(areas: readonly CapabilityArea[], known: ReadonlySet<string>): string[] {
  return areas.flatMap((a) =>
    a.guides
      .filter((slug) => !known.has(slug))
      .map((slug) => `${a.area}: routes to ${slug}, which core does not serve`),
  );
}

// A flag is one or two dashes and a letter that no word or dash precedes: after a space, a
// backtick, a bracket, a quote or other punctuation, and at the start of a line. A hyphen inside a
// word ("well-known"), an em dash and a table rule ("|---|") have a word or a dash before them or no
// letter after them, so they are not flags.
const FLAG = /(?<![\w-])(--?[A-Za-z][\w-]*)/;
const TOOL_NAME = /\bforge_[a-z_]+/;

/** Each match of a flag or an MCP tool name in `text`, named. */
function surfaceFaults(label: string, text: string): string[] {
  const faults: string[] = [];
  for (const [kind, re] of [
    ['a CLI flag', FLAG],
    ['an MCP tool name', TOOL_NAME],
  ] as const) {
    const m = re.exec(text);
    if (m) faults.push(`${label}: carries ${kind} (${JSON.stringify(m[1] ?? m[0])})`);
  }
  return faults;
}

/** Every string a statement carries, one per line: what a reader of it can read. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(textOf).join('\n');
  return '';
}

const KNOWN = new Set(FORGE_GUIDES.map((g) => g.slug));

describe('the capability guide', () => {
  it('is served under its own slug, as an agent guide', () => {
    expect(getGuide(CAPABILITY_GUIDE_SLUG)).toBe(CAPABILITY_GUIDE);
    expect(CAPABILITY_GUIDE.audience).toBe('agent');
  });

  it('routes every area only to guides core serves', () => {
    expect(CAPABILITY_AREAS.length).toBeGreaterThan(5);
    expect(routeFaults(CAPABILITY_AREAS, KNOWN)).toEqual([]);
  });

  it('names the guide that covers each area in its body', () => {
    for (const a of CAPABILITY_AREAS) {
      expect(a.guides.length, a.area).toBeGreaterThan(0);
      for (const slug of a.guides)
        expect(CAPABILITY_GUIDE.body, `${a.area}/${slug}`).toContain(`/api/guides/${slug}.md`);
    }
  });

  it('leaves no guide core serves unreachable from the map, the map itself excepted', () => {
    const routed = new Set(CAPABILITY_AREAS.flatMap((a) => a.guides));
    const orphans = FORGE_GUIDES.map((g) => g.slug).filter(
      (slug) => slug !== CAPABILITY_GUIDE_SLUG && !routed.has(slug),
    );
    expect(orphans).toEqual([]);
  });

  it('carries no flag and no tool name, here or in the corpus text', () => {
    expect(surfaceFaults('capability guide', CAPABILITY_GUIDE.body)).toEqual([]);
    expect(surfaceFaults('corpus scope', textOf(CORPUS_SCOPE))).toEqual([]);
  });

  it('puts the sentence calling the CLI names a pointer directly above those names', () => {
    expect(CAPABILITY_GUIDE.body).toContain(
      `${CORPUS_SCOPE.authority}\n\n${cliServedBullets().join('\n')}`,
    );
    const keys = Object.keys(CORPUS_SCOPE);
    expect(keys.indexOf('cliServed') - keys.indexOf('authority')).toBe(1);
  });

  it('points at the CLI for methods rather than restating one', () => {
    expect(CAPABILITY_GUIDE.body).toContain(CORPUS_SCOPE.reach);
    expect(CAPABILITY_GUIDE.body).toContain(CORPUS_SCOPE.authority);
  });
});

describe('those rules, against planted faults', () => {
  it('names a route to a slug core does not serve', () => {
    const planted: CapabilityArea[] = [{ area: 'Planted', covers: 'x', guides: ['no-such-guide'] }];
    expect(routeFaults(planted, KNOWN)).toEqual([
      'Planted: routes to no-such-guide, which core does not serve',
    ]);
  });

  it('names a CLI flag planted in a body', () => {
    expect(surfaceFaults('planted', 'run it with --force to skip')).toEqual([
      'planted: carries a CLI flag ("--force")',
    ]);
  });

  // The spellings a page carries a flag in: beside a command in backticks, in a bracket, in a
  // quote, after punctuation, at the start of a line, with a value, and as a one-letter flag.
  const SPELLINGS: ReadonlyArray<readonly [string, string, string]> = [
    ['after a space', 'Run it with --force to skip.', '--force'],
    ['in backticks', 'Run it with `--force` to skip.', '--force'],
    ['in parentheses', 'Read it whole (--force) first.', '--force'],
    ['in a quote', 'The "--force" switch skips it.', '--force'],
    ['after a colon', 'The switch:--force skips it.', '--force'],
    ['after a comma', 'Take it, --force, and go.', '--force'],
    ['at the start of a line', 'Intro.\n--force skips it.', '--force'],
    ['with a value', 'Pass `--limit=5` for fewer.', '--limit'],
    ['as a short flag', 'Run it with -f to skip.', '-f'],
    ['as a short flag in backticks', 'Run it with `-f` to skip.', '-f'],
    ['as a short flag in parentheses', 'Read it whole (-f) first.', '-f'],
  ];

  describe.each(SPELLINGS)('a flag %s', (_spelling, sentence, flag) => {
    it('is named in the capability guide', () => {
      expect(surfaceFaults('capability guide', `${CAPABILITY_GUIDE.body}\n${sentence}`)).toEqual([
        `capability guide: carries a CLI flag (${JSON.stringify(flag)})`,
      ]);
    });

    it.each(['listed', 'elsewhere', 'reach', 'authority'] as const)(
      'is named in the corpus text, planted in its %s statement',
      (field) => {
        const planted = { ...CORPUS_SCOPE, [field]: `${CORPUS_SCOPE[field]}\n${sentence}` };
        expect(surfaceFaults('corpus scope', textOf(planted))).toEqual([
          `corpus scope: carries a CLI flag (${JSON.stringify(flag)})`,
        ]);
      },
    );

    it('is named in a method the CLI serves, planted in what it covers', () => {
      const [first, ...rest] = CORPUS_SCOPE.cliServed;
      const planted = { ...CORPUS_SCOPE, cliServed: [{ ...first, covers: sentence }, ...rest] };
      expect(surfaceFaults('corpus scope', textOf(planted))).toEqual([
        `corpus scope: carries a CLI flag (${JSON.stringify(flag)})`,
      ]);
    });
  });

  it('does not name a hyphenated word, a dash, a rule or a slug as a flag', () => {
    const prose = [
      'A well-known, pre-existing issue — see the e-mail; a dash - and an en dash \u2013 stand alone.',
      '|---|---|',
      'Read [what-is-an-issue](/api/guides/what-is-an-issue.md) and -1 of them (negative one).',
      'Method-guides are served by the CLI: build-time names, read-only.',
    ].join('\n');
    expect(surfaceFaults('prose', prose)).toEqual([]);
  });

  it('names an MCP tool name planted in a body', () => {
    expect(surfaceFaults('planted', 'call forge_issues to read it')).toEqual([
      'planted: carries an MCP tool name ("forge_issues")',
    ]);
  });
});
