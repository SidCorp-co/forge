/**
 * The comment a review becomes, and the key that makes it write once.
 *
 * What is HERE is what is a property of the text: the marker's shape, the verdict's wording, the
 * reviewer's own words being quoted rather than paraphrased, and the refusal of an id that could
 * turn the duplicate check into a wildcard. What is NOT here is the writing itself — one locked
 * transaction over two tables is a property of Postgres, and a stub whose `where` returned itself
 * would let the whole of it pass with the lock deleted. That is
 * `tests/integration/github-review-note-e2e.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x/y',
    DEVICE_TOKEN_PEPPER: 'pepper',
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const { noteReviewOnIssue, reviewMarker, reviewNoteBody } = await import('./review-note.js');

const REVIEW = {
  id: '2847100311',
  reviewer: 'junixlabs',
  state: 'changes_requested',
  submittedAt: '2026-09-17T10:39:38Z',
  url: 'https://github.com/SidCorp-co/forge-dev/pull/481#pullrequestreview-2847100311',
  body: 'The projection half is right.\nThe adapter half is not.',
};

describe('the marker', () => {
  it('carries GitHub s own review id and nothing else', () => {
    expect(reviewMarker('2847100311')).toBe('[github-review:2847100311]');
  });

  it('is in the body the comment carries, so the duplicate check has something to find', () => {
    const body = reviewNoteBody({
      review: REVIEW,
      repository: 'SidCorp-co/forge-dev',
      number: 481,
    });
    expect(body).toContain(reviewMarker(REVIEW.id));
  });
});

describe('the comment a review becomes', () => {
  it('names the reviewer, the verdict and the pull request it was left on', () => {
    const body = reviewNoteBody({
      review: REVIEW,
      repository: 'SidCorp-co/forge-dev',
      number: 481,
    });
    expect(body).toContain('**junixlabs** requested changes on');
    expect(body).toContain(
      '[SidCorp-co/forge-dev#481](https://github.com/SidCorp-co/forge-dev/pull/481',
    );
    expect(body).toContain('at 2026-09-17T10:39:38Z');
  });

  it('quotes what the reviewer wrote, every line of it, rather than paraphrasing', () => {
    const body = reviewNoteBody({
      review: REVIEW,
      repository: 'SidCorp-co/forge-dev',
      number: 481,
    });
    expect(body).toContain('> The projection half is right.');
    expect(body).toContain('> The adapter half is not.');
  });

  it('says a verdict came with no text rather than rendering an empty quote', () => {
    const body = reviewNoteBody({
      review: { ...REVIEW, body: '   ' },
      repository: 'SidCorp-co/forge-dev',
      number: 481,
    });
    expect(body).toContain('_No text, only the verdict._');
    expect(body).not.toContain('> \n');
  });

  it('renders a state it has no word for as the state itself, not as a guess', () => {
    const body = reviewNoteBody({
      review: { ...REVIEW, state: 'pending' },
      repository: 'SidCorp-co/forge-dev',
      number: 481,
    });
    expect(body).toContain('`pending`');
  });

  it('falls back to a plain reference when GitHub sent no URL', () => {
    const body = reviewNoteBody({
      review: { ...REVIEW, url: null },
      repository: 'SidCorp-co/forge-dev',
      number: 481,
    });
    expect(body).toContain('SidCorp-co/forge-dev#481');
    expect(body).not.toContain('](');
  });
});

describe('an id that is not GitHub s', () => {
  it('is refused by name before any row is touched', async () => {
    await expect(
      noteReviewOnIssue({
        projectId: '11111111-1111-4111-8111-111111111111',
        headRef: 'ISS-1074',
        repository: 'SidCorp-co/forge-dev',
        number: 481,
        review: { ...REVIEW, id: '284%' },
      }),
    ).rejects.toThrow(/is not a number/);
  });
});
