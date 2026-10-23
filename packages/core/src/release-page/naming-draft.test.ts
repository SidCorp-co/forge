// A release's name and summary as the assistant drafts them (REQ-40 BC-14), judged before they are
// written: plain words a person using the product follows (BC-15), two or three whole sentences, no
// figure the release's record does not state; and drafted from what users see of the release alone.

import type { ReleaseNamingFacts } from '@forge/contracts/release-naming';
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
  requirements: [
    {
      key: 'REQ-17',
      title: 'Workflows are drawn',
      text: 'Every workflow reads as a map.',
      completes: false,
    },
  ],
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

describe('what the namer reads of a release', () => {
  it('reads each change users see and the requirements it carries, never a change nobody sees', () => {
    const detail = {
      version: '0.4.0-dev.289',
      notes: {
        sections: [
          {
            section: 'Changed',
            entries: [
              {
                key: 'ISS-646',
                title: 't',
                heading: 'Workflows fit a phone',
                userFacing: 'It fits.',
                technical: 'x.tsx',
                adminSteps: [],
              },
            ],
          },
          {
            section: 'Skip',
            entries: [
              {
                key: 'ISS-7',
                title: 't',
                heading: null,
                userFacing: '-',
                technical: null,
                adminSteps: [],
              },
            ],
          },
        ],
      },
    } as unknown as ReleaseDetail;
    const facts = namingFacts(detail, [
      {
        key: 'REQ-17',
        title: 'Workflows are drawn',
        tldr: null,
        completes: true,
        criteria: new Map(),
      },
    ]);
    expect(facts).toEqual({
      version: '0.4.0-dev.289',
      changes: [{ title: 'Workflows fit a phone', line: 'It fits.' }],
      requirements: [{ key: 'REQ-17', title: 'Workflows are drawn', text: '', completes: true }],
    });
  });
});
