import { describe, expect, it } from 'vitest';
import { MARK_MERGED_ACTION, WHERE_IT_LANDED_FIELD, markMergedSteps } from './mark-merged-words.js';

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
});
