/**
 * ISS-1108 — the non-work exit as the two surfaces that SHIP it state it: the mandatory
 * pipeline-rules block a job is handed, and the public `what-is-an-issue` guide. The rule itself
 * is held at `merged-at.test.ts` and `tests/integration/closed-means-shipped-e2e.test.ts`; a
 * repository that refuses the close while its own prompt still teaches `closed` + `unmark` has
 * moved the contradiction rather than closed it. The second subject here is the SHAPE those same
 * surfaces give the rule.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { APP_BASE_URL: 'https://forge.example.com', NODE_ENV: 'test' },
}));

const { mandatoryPreambleBlocks } = await import('../prompt/facts/mandatory-blocks.js');
const { guideRoutes } = await import('../guides/routes.js');
const { listGuides } = await import('../guides/registry.js');

const NAMES_A_CLOSE = /`closed`|clos(e|es|ed|ing)\b/i;
const THE_SUBJECT_THAT_MAY_NOT_CLOSE =
  /never landed|never shipped|unshipped|not (to be )?work|non-work|no `merged_at`|abandoned|unmark/i;
const REFUSES_IT = /cannot|refus|never by|not by|instead|may not|rather than/i;

/**
 * Every sentence that puts a close and work that cannot show it shipped in one breath WITHOUT
 * refusing the pairing. Keyword presence is not read as a refusal on its own: the refusal has to
 * be in the sentence that names the close, which is what "close it, then unmark it" never has.
 */
function sentencesRoutingNonWorkToAClose(text: string): string[] {
  return text
    .split(/(?<=[.:;])\s+/)
    .filter((sentence) => NAMES_A_CLOSE.test(sentence))
    .filter((sentence) => THE_SUBJECT_THAT_MAY_NOT_CLOSE.test(sentence))
    .filter((sentence) => !REFUSES_IT.test(sentence));
}

const arms = [
  ['drive', mandatoryPreambleBlocks('drive').pipelineRules],
  ['code', mandatoryPreambleBlocks('code').pipelineRules],
] as const;

describe('the mandatory pipeline-rules block a job is given', () => {
  it.each(arms)('names `dropped` as the exit for work that never landed (%s)', (_step, text) => {
    expect(text).toMatch(/`dropped` is its exit/);
    expect(text).toContain('CLOSE_REQUIRES_SHIPPED');
  });

  it.each(arms)('routes nothing that never landed to a close (%s)', (_step, text) => {
    expect(sentencesRoutingNonWorkToAClose(text)).toEqual([]);
  });
});

async function nonWorkSectionOfServedGuide(): Promise<string> {
  const app = new Hono().route('/api', guideRoutes);
  const res = await app.request('/api/guides/what-is-an-issue.md');
  expect(res.status).toBe(200);
  const markdown = await res.text();
  const from = markdown.indexOf('### When you find one that is not work');
  const to = markdown.indexOf('### Then read', from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return markdown.slice(from, to);
}

describe('the public what-is-an-issue guide, where it routes non-work', () => {
  it('names `dropped` as the status to write', async () => {
    expect(await nonWorkSectionOfServedGuide()).toMatch(/`dropped`/);
  });

  it('routes nothing that is not work to a close', async () => {
    expect(sentencesRoutingNonWorkToAClose(await nonWorkSectionOfServedGuide())).toEqual([]);
  });
});

describe('the guard itself, against the wordings the same mistake comes back in', () => {
  const recurrences = [
    'Use `closed` for work that never shipped.',
    'Closing unshipped work releases its dependents.',
    'Close it and then unmark it when it turns out not to be work.',
    'Closing an issue whose code never landed does unblock its dependents.',
    '`closed` when it is not work at all.',
  ];

  it.each(recurrences)('rejects %s', (sentence) => {
    expect(sentencesRoutingNonWorkToAClose(sentence)).toEqual([sentence]);
  });

  it('lets the refusals this repository actually ships through', () => {
    const shipped = [
      'An abandoned issue whose code never landed cannot be closed at all.',
      'Non-work leaves by `dropped`, never by `closed`.',
      'A close with no `merged_at` is refused by name (`CLOSE_REQUIRES_SHIPPED`).',
    ];
    expect(sentencesRoutingNonWorkToAClose(shipped.join(' '))).toEqual([]);
  });
});

const ABSOLUTE =
  '(?:no way|cannot|can never|never|nothing|impossible|(?:by |in )?any route|whatever route|no route)';
const REACHING_THE_STATE =
  '(?:reach|reached|write|writes|written|exist|exists|stand|stands|put|get)';

/**
 * The rule `trg_issues_closed_means_shipped` holds governs the TRANSITION into `closed`, so a row
 * closed before it landed keeps its null `merged_at` and stays writable. A sentence promising
 * instead that the STATE is unreachable is false for every one of those rows, and the reader it is
 * false to is looking at them. One that scopes itself to entry is the rule and is left alone.
 */
const CLAIMS_THE_STATE_ITSELF_IS_UNREACHABLE = new RegExp(
  [
    `\\b${ABSOLUTE}\\b[^.;:]{0,80}\\b${REACHING_THE_STATE}\\b[^.;:]{0,40}\`?closed\`?`,
    `\\bno \`?\\w+\`? (?:row|issue)s?\\b[^.;:]{0,40}\\b(?:can|may|could|will)\\b[^.;:]{0,25}\\b${REACHING_THE_STATE}\\b`,
  ].join('|'),
  'i',
);
const SCOPES_ITSELF_TO_THE_TRANSITION = /transition|\benter(s|ing|ed)?\b|\binto `?closed/i;

function sentencesPromisingTheClosedStateCannotExist(text: string): string[] {
  return text
    .split(/(?<=[.;:])\s+/)
    .filter((sentence) => CLAIMS_THE_STATE_ITSELF_IS_UNREACHABLE.test(sentence))
    .filter((sentence) => !SCOPES_ITSELF_TO_THE_TRANSITION.test(sentence));
}

async function servedGuide(slug: string): Promise<string> {
  const app = new Hono().route('/api', guideRoutes);
  const res = await app.request(`/api/guides/${slug}.md`);
  expect(res.status).toBe(200);
  return await res.text();
}

describe('the public guides, where they state what the close rule guarantees', () => {
  it.each(listGuides().map((g) => g.slug))('promises no unreachable state (%s)', async (slug) => {
    expect(sentencesPromisingTheClosedStateCannotExist(await servedGuide(slug))).toEqual([]);
  });

  it('says the rule governs entry, and that earlier closes keep what they hold', async () => {
    const markdown = await servedGuide('pipeline-and-issue-lifecycle');
    expect(markdown).toMatch(/refuses the same TRANSITION/);
    expect(markdown).toMatch(/still read `closed` with no `merged_at`/);
  });
});

describe('the mandatory pipeline-rules block, on the same rule', () => {
  it.each(arms)('promises no unreachable state (%s)', (_step, text) => {
    expect(sentencesPromisingTheClosedStateCannotExist(text)).toEqual([]);
  });
});

describe('that guard, against the wordings the state-shaped promise comes back in', () => {
  const recurrences = [
    'There is no way to reach `closed` without having shipped.',
    'An `issues` row cannot be written to `closed` with a null `merged_at` by any route.',
    'Nothing may write `closed` while `merged_at` is null.',
    'No `closed` row can exist with no `merged_at`, and none ever did.',
    'The database refuses the same write whatever route it took, so nothing stands at `closed` unshipped.',
  ];

  it.each(recurrences)('rejects %s', (sentence) => {
    expect(sentencesPromisingTheClosedStateCannotExist(sentence)).toEqual([sentence]);
  });

  it('lets the entry-scoped rule this repository actually ships through', () => {
    const shipped = [
      'Nothing may ENTER `closed` while `merged_at` is null, whatever the gate lists.',
      'A close is refused (`CLOSE_REQUIRES_SHIPPED`) while the issue carries no `merged_at`.',
      'The rule governs the transition and not the state, so rows closed before it landed still read `closed` with no `merged_at` and are still writable.',
      'An abandoned issue whose code never landed cannot be closed at all.',
    ];
    expect(sentencesPromisingTheClosedStateCannotExist(shipped.join(' '))).toEqual([]);
  });
});
