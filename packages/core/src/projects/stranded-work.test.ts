/**
 * ISS-1171 — the two project writes that would strand work, refused by name. The sentences are
 * proved here; the reads behind them, against a real database and through both doors, are
 * `tests/integration/release-chain-strands-work-e2e.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { canonicalIssueKey } from '../lib/issue-ref.js';
import {
  chainStrandsWork,
  kindStrandsWork,
  PROJECT_KIND_STRANDS_WORK,
  RELEASE_CHAIN_STRANDS_WORK,
  STRANDED_NAMED_MAX,
} from './stranded-work.js';

const keys = (n: number) => Array.from({ length: n }, (_, i) => canonicalIssueKey(i + 1));

describe('chainStrandsWork', () => {
  it('opens with its own code and carries every waiting key in details', () => {
    const r = chainStrandsWork(keys(3));
    expect(r.code).toBe(RELEASE_CHAIN_STRANDS_WORK);
    expect(r.message.startsWith(`${RELEASE_CHAIN_STRANDS_WORK}: `)).toBe(true);
    expect(r.details).toEqual({ issues: keys(3), total: 3, status: 'awaiting_release' });
    expect(r.message).toContain('ISS-1, ISS-2, ISS-3');
  });

  it('names both ways out, and says a close is not one', () => {
    const r = chainStrandsWork(['ISS-7']);
    expect(r.message).toContain('Release them first');
    expect(r.message).toContain('return each one to `developed`');
    expect(r.message).toContain('Closing them is not a way out');
  });

  it('speaks of one issue in the singular', () => {
    expect(chainStrandsWork(['ISS-7']).message).toContain('1 of its issue waits at');
  });

  it(`names at most ${STRANDED_NAMED_MAX} keys and counts the rest, while details keep all of them`, () => {
    const r = chainStrandsWork(keys(STRANDED_NAMED_MAX + 4));
    expect(r.message).toContain(`${canonicalIssueKey(STRANDED_NAMED_MAX)} and 4 more`);
    expect(r.message).not.toContain(`${canonicalIssueKey(STRANDED_NAMED_MAX + 1)},`);
    expect(r.details.issues).toHaveLength(STRANDED_NAMED_MAX + 4);
  });

  it('names exactly the cap with no "more" at the boundary', () => {
    expect(chainStrandsWork(keys(STRANDED_NAMED_MAX)).message).not.toContain('more');
  });
});

describe('kindStrandsWork', () => {
  const marked = [{ key: 'ISS-4', why: 'a mark naming no landing' }];

  it('opens with its own code, names the move and the issue', () => {
    const r = kindStrandsWork({
      from: 'standard',
      to: 'website',
      was: { shape: 'git', declared: false },
      marked,
    });
    expect(r.code).toBe(PROJECT_KIND_STRANDS_WORK);
    expect(r.message.startsWith(`${PROJECT_KIND_STRANDS_WORK}: `)).toBe(true);
    expect(r.message).toContain('from `standard` to `website`');
    expect(r.message).toContain('ISS-4');
    expect(r.details).toEqual({ issues: ['ISS-4'], total: 1 });
  });

  it('tells the caller to pin each issue to the lane its mark was written for', () => {
    const fromGit = kindStrandsWork({
      from: 'standard',
      to: 'website',
      was: { shape: 'git', declared: false },
      marked,
    });
    expect(fromGit.message).toContain('`landingShape: git`');
    expect(fromGit.message).toMatch(
      /withdraw its mark .*`unmark`.*declare `landingShape: git`.*mark it merged again/,
    );
    const fromOutside = kindStrandsWork({
      from: 'website',
      to: 'standard',
      was: { shape: 'outside_git', declared: false },
      marked,
    });
    expect(fromOutside.message).toContain('`landingShape: outside_git`');
  });
});
