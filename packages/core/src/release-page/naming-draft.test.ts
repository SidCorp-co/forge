// A release's name and summary as the assistant drafts them (REQ-40 BC-14), judged before they are
// written: plain words a person using the product follows (BC-15), two or three whole sentences, no
// figure the release's record does not state; and drafted from the issues the release carries alone,
// never from a requirement they serve.

import {
  namingForOperatorsOnly,
  namingHasFacts,
  type ReleaseNamingFacts,
} from '@forge/contracts/release-naming';
import type { ReleaseDetail } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import { judgedNaming, namingFacts } from './naming-draft.js';

const FACTS: ReleaseNamingFacts = {
  version: '0.4.0-dev.289',
  changes: [
    {
      title: 'Workflows fit a phone',
      line: 'The Workflows page switches between designs and the map at any width.',
    },
  ],
  operatorChanges: [],
  unnoted: [],
};

const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'Workflows on any screen',
    summary:
      'The Workflows page now fits a phone. Switch between your designs and the map with one tap.',
    ...over,
  });

describe('a drafted release name judged before it is written (BC-14, BC-15)', () => {
  it('keeps a short name and a summary of two whole sentences in plain words', () => {
    expect(judgedNaming(`Here it is: ${answer()}`, FACTS)).toEqual({
      ok: true,
      naming: {
        name: 'Workflows on any screen',
        summary:
          'The Workflows page now fits a phone. Switch between your designs and the map with one tap.',
      },
    });
  });

  it.each([
    ['an answer that is no JSON object', 'Workflows on any screen', 'RELEASE_NAMING_SHAPE'],
    [
      'a summary of one sentence',
      answer({ summary: 'Workflows fit a phone.' }),
      'RELEASE_NAMING_SHAPE',
    ],
    [
      'a name of seven words',
      answer({ name: 'The workflows page now fits every phone' }),
      'RELEASE_NAMING_SHAPE',
    ],
    [
      'a requirement key and a criterion code',
      answer({ summary: 'REQ-17 moves on. BC-29 is met at last.' }),
      'RELEASE_NAMING_JARGON',
    ],
    [
      'a file path',
      answer({ summary: 'The page in workflows-page.tsx fits a phone. Switch with one tap.' }),
      'RELEASE_NAMING_JARGON',
    ],
    [
      'a figure the release never states',
      answer({ summary: 'The Workflows page now loads 3 times faster. Switch with one tap.' }),
      'RELEASE_NAMING_FIGURE_UNBACKED',
    ],
  ])('refuses %s by name', (_what, text, code) => {
    const out = judgedNaming(text, FACTS);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusals.map((r) => r.code)).toContain(code);
  });
});

const entry = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  title: `${key} title`,
  heading: null,
  userFacing: '-',
  technical: null,
  adminSteps: [],
  ...over,
});

const detailOf = (notes: Record<string, unknown>) =>
  ({
    version: '0.4.0-dev.289',
    notes: { sections: [], designs: [], withoutNotes: [], skipped: [], ...notes },
  }) as unknown as ReleaseDetail;

describe('what the namer reads of a release', () => {
  it('reads each carried issue by its note, a Skip note as a change only operators see', () => {
    const facts = namingFacts(
      detailOf({
        sections: [
          {
            section: 'Changed',
            entries: [
              entry('ISS-646', {
                heading: 'Workflows fit a phone',
                userFacing: 'It fits.',
                technical: 'x.tsx',
              }),
            ],
          },
          { section: 'Skip', entries: [entry('ISS-7')] },
        ],
        skipped: [entry('ISS-7', { technical: '/healthz names the commit it serves.' })],
      }),
      new Map(),
    );
    expect(facts).toEqual({
      version: '0.4.0-dev.289',
      changes: [{ title: 'Workflows fit a phone', line: 'It fits.' }],
      operatorChanges: [{ title: 'ISS-7 title', line: '/healthz names the commit it serves.' }],
      unnoted: [],
    });
    expect(namingForOperatorsOnly(facts)).toBe(false);
  });

  it('reads an issue with no note by its own criteria, and nothing of the requirement it serves', () => {
    const facts = namingFacts(
      detailOf({
        withoutNotes: [{ key: 'ISS-16', title: 'Health names its build' }],
        // what the release record says the release advances: never read for its name
        requirementsCompleted: [{ key: 'REQ-3', title: 'One version shown everywhere' }],
      }),
      new Map([['ISS-16', ['GET /healthz answers with the commit it serves.']]]),
    );
    expect(facts.unnoted).toEqual([
      {
        title: 'Health names its build',
        criteria: ['GET /healthz answers with the commit it serves.'],
      },
    ]);
    expect(JSON.stringify(facts)).not.toContain('One version shown everywhere');
  });

  it('names a release of operator changes only as one, and has nothing to name a design-only one from', () => {
    const operators = namingFacts(detailOf({ skipped: [entry('ISS-16')] }), new Map());
    expect(namingForOperatorsOnly(operators)).toBe(true);
    const designs = namingFacts(detailOf({ designs: [entry('ISS-9')] }), new Map());
    expect(namingHasFacts(designs)).toBe(false);
  });
});
