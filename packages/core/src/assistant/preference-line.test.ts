/**
 * What a turn is told about the person it answers (ISS-1034): one reply-style
 * line for a linked speaker with a style, their instructions when set, the
 * unlinked sentence for a speaker nobody Forge knows, and nothing at all for a
 * linked speaker on the defaults.
 */
import { describe, expect, it } from 'vitest';
import { speakerSection } from './preference-line.js';

const U = '11111111-1111-4111-8111-111111111111';

describe('speakerSection', () => {
  it('names the style once for a linked speaker (criterion 17)', () => {
    const s = speakerSection({
      speakerUserId: U,
      speakerLabel: null,
      preferences: { answerStyle: 'concise', assistantInstructions: null },
    });
    expect(s).toMatch(/^Reply style for the person you are answering: concise — /);
    expect(s?.split('\n')).toHaveLength(1);
  });

  it('adds the standing instructions verbatim when set', () => {
    const s = speakerSection({
      speakerUserId: U,
      speakerLabel: null,
      preferences: { answerStyle: 'bullets', assistantInstructions: 'Always cite the issue key.' },
    });
    expect(s).toContain('bullets');
    expect(s).toContain('Their standing instructions for every reply:\nAlways cite the issue key.');
  });

  it('says nothing for a linked speaker on the defaults', () => {
    expect(
      speakerSection({
        speakerUserId: U,
        speakerLabel: null,
        preferences: { answerStyle: 'default', assistantInstructions: null },
      }),
    ).toBeNull();
    expect(speakerSection({ speakerUserId: U, speakerLabel: null, preferences: null })).toBeNull();
  });

  it('states that an unlinked speaker is not linked, with no preference line (criteria 19, 20)', () => {
    const s = speakerSection({ speakerUserId: null, speakerLabel: '@tuyen', preferences: null });
    expect(s).toBe(
      'Speaker: the newest message is from @tuyen, who is not linked to a Forge user. No preferences apply to this reply, and nothing may be written on their behalf.',
    );
    expect(s).not.toContain('Reply style');
  });

  it('says nothing when there is neither a link nor a label to name', () => {
    expect(
      speakerSection({ speakerUserId: null, speakerLabel: null, preferences: null }),
    ).toBeNull();
  });
});
