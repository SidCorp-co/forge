import { describe, expect, it } from 'vitest';
import {
  heldBackWarningSentence,
  releaseBlockerSentence,
} from '../release-batch/blocker-sentences.js';
import type { ServingReading } from '../release-batch/serving-reading.js';
import { landingCorrection } from './landing-correction.js';

// ISS-1300 r2: an issue whose recorded landing is not in its repository owes no verdict; its record
// does, and the readiness page and the release-create refusal say so in the issue hold's own words.
describe('the criteria hold for an issue whose recorded landing is not in its repository', () => {
  const ABSENT = '0d018a9a0e1cf5dadf2b1b3be9ba1b81c5e9cb40';
  const unresolved = {
    issueId: 'u-578',
    displayId: 'ISS-578',
    criteria: [1, 2, 3],
    unresolvedLanding: {
      commit: ABSENT,
      repository: 'SidCorp-co/sid-desk',
      from: 'merge' as const,
    },
  };
  const owing = { issueId: 'u-7', displayId: 'ISS-7', criteria: [2] };
  const served: ServingReading = { kind: 'serving', served: [], unread: [], readAt: 'now' };

  it('names the record and the act that corrects it, never a verdict owed', () => {
    const message = releaseBlockerSentence('RELEASE_CRITERIA_UNEARNED', { held: [unresolved] });

    expect(message).toContain(
      `\`ISS-578\` records ${ABSENT} as landed, which SidCorp-co/sid-desk does not hold`,
    );
    expect(message).toContain(landingCorrection('merge'));
    expect(message).not.toContain('owes');
    expect(message).not.toContain('verdict on an acceptance criterion');
  });

  it('keeps the other issues on their verdicts beside it', () => {
    const message = releaseBlockerSentence('RELEASE_CRITERIA_UNEARNED', {
      held: [owing, unresolved],
    });

    expect(message).toContain('`ISS-7` owes criterion 2');
    expect(message).not.toContain('`ISS-578` owes');
    expect(message).toContain(landingCorrection('merge'));
  });

  it('says the same act in the warning where only some issues are held', () => {
    const alone = heldBackWarningSentence([unresolved], served);
    expect(alone).toContain(landingCorrection('merge'));
    expect(alone).not.toContain('owes');
    const beside = heldBackWarningSentence([owing, unresolved], served);
    expect(beside).toContain('`ISS-7` owes criterion 2');
    expect(beside).not.toContain('`ISS-578` owes');
  });

  it('names the landing record by a person act where no merge mark records it', () => {
    const landing = {
      ...unresolved,
      unresolvedLanding: { ...unresolved.unresolvedLanding, from: 'landing' as const },
    };
    const message = releaseBlockerSentence('RELEASE_CRITERIA_UNEARNED', { held: [landing] });

    expect(message).toContain('the landing record is corrected');
    expect(message).toContain(landingCorrection('landing'));
  });
});
