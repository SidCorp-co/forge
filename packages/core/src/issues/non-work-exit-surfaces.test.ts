/**
 * ISS-1108 — the non-work exit as the two surfaces that SHIP it state it: the mandatory
 * pipeline-rules block a job is handed, and the public `what-is-an-issue` guide. The rule itself
 * is held at `merged-at.test.ts` and `tests/integration/closed-means-shipped-e2e.test.ts`; a
 * repository that refuses the close while its own prompt still teaches `closed` + `unmark` has
 * moved the contradiction rather than closed it.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { APP_BASE_URL: 'https://forge.example.com', NODE_ENV: 'test' },
}));

const { mandatoryPreambleBlocks } = await import('../prompt/facts/mandatory-blocks.js');
const { guideRoutes } = await import('../guides/routes.js');

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
