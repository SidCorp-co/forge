import { describe, expect, it } from 'vitest';
import {
  COMMIT_FIELD,
  MARK_MERGED_ACTION,
  WHERE_IT_LANDED_FIELD,
  markMergedSteps,
} from './mark-merged-words.js';

describe('the Mark merged steps (ISS-1421 r4 repair 1)', () => {
  it('names the action and the field as the page labels them', () => {
    for (const outsideGit of [false, true]) {
      const steps = markMergedSteps(outsideGit);
      expect(steps).toContain(`Use ${MARK_MERGED_ACTION} in the issue's properties.`);
      expect(steps).toContain('In the panel it opens,');
      expect(steps).toContain(WHERE_IT_LANDED_FIELD);
    }
  });

  it('says what a landing outside git is', () => {
    expect(markMergedSteps(true)).toContain('the live URL, CMS entry or storefront resource');
    expect(markMergedSteps(false)).not.toContain('storefront');
  });

  // ISS-1300 r5 (judge-125, X3): the hold names Commit for a landing in git, so the banner does too.
  it('names the commit that landed under Commit in git, as the hold does, and never outside it', () => {
    expect(markMergedSteps(false)).toBe(
      `Use ${MARK_MERGED_ACTION} in the issue's properties. In the panel it opens, fill in ${WHERE_IT_LANDED_FIELD} and name the commit that landed under ${COMMIT_FIELD}.`,
    );
    expect(markMergedSteps(true)).not.toContain(COMMIT_FIELD);
  });

  // ISS-1421 r40 (judge-164): a project naming no repository accepts a mark naming no commit.
  it('says Commit may stay empty on a project naming no repository, and asks for no commit', () => {
    const steps = markMergedSteps(false, 'claim');
    expect(steps).toBe(
      `Use ${MARK_MERGED_ACTION} in the issue's properties. In the panel it opens, fill in ${WHERE_IT_LANDED_FIELD}; with no repository named, ${COMMIT_FIELD} may stay empty.`,
    );
    expect(steps).not.toContain('name the commit');
    expect(markMergedSteps(true, 'claim')).toBe(markMergedSteps(true));
  });

  // ISS-1421 r43 (judge-171 on 407): a repository Forge cannot read refuses a named commit.
  it('says to leave Commit empty where Forge cannot read the repository, and asks for no commit', () => {
    const steps = markMergedSteps(false, 'refused');
    expect(steps).toContain(`Leave ${COMMIT_FIELD} empty to record a claim naming no commit.`);
    expect(steps).not.toContain('name the commit');
    expect(markMergedSteps(false, null)).toBe(markMergedSteps(false, 'checked'));
  });
});
