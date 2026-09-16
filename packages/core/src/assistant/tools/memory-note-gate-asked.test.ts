/**
 * ISS-1064 — the gate's `unasked` rule: a fact nobody asked to keep that settles nothing is refused,
 * and a correction may replace the value it corrects.
 */

import { describe, expect, it } from 'vitest';
import { judgeNote, type NoteRefusal, refusalText } from './memory-note-gate.js';
import { base, code } from './memory-note-gate-ground.js';

describe('judgeNote: asked', () => {
  it('a fact merely stated is refused as unasked; an ask anywhere in a recent message, a correction, or a decision passes', () => {
    const said = 'Our deploy window is Wednesday, right after the morning standup.';
    const r = judgeNote(
      base({ text: 'Deploy window: Wednesday after the morning standup.', recentTurns: [said] }),
    );
    expect(r?.code).toBe('unasked');
    expect(
      code(
        base({
          text: 'Release lead: Marta Okafor.',
          recentTurns: ['For the next release, note that the release lead is Marta Okafor.'],
        }),
      ),
    ).toBeNull();
    // an earlier ask covers the fact it names, not the statements after it
    expect(
      code(
        base({
          text: 'Deploy window: Wednesday after standup.',
          recentTurns: ['Remember this: our deploy window is Wednesday after standup.', 'Thanks.'],
        }),
      ),
    ).toBeNull();
    expect(
      code(
        base({
          text: 'Deploy window: Wednesday after standup.',
          recentTurns: ['Remember this for our chat: the window matters.', said],
        }),
      ),
    ).toBe('unasked');
    for (const ask of [
      'Store for this project: the release code name is bench-1a2b3c4d5e6f.',
      'Save the release code name: bench-1a2b3c4d5e6f.',
      'Note: the release code name is bench-1a2b3c4d5e6f.',
    ]) {
      expect(
        code(base({ text: 'Release code name: bench-1a2b3c4d5e6f.', recentTurns: [ask] })),
        ask,
      ).toBeNull();
    }
    expect(
      code(
        base({
          text: 'Release code name: bench-9f8e7d6c5b4a.',
          recentTurns: [
            'Correction: the release code name is bench-9f8e7d6c5b4a, forget the first one.',
          ],
        }),
      ),
    ).toBeNull();
    expect(
      code(
        base({
          text: 'We decided to deploy on Wednesdays only.',
          recentTurns: ['We decided to deploy on Wednesdays only, no exceptions.'],
        }),
      ),
    ).toBeNull();
    expect(
      code(
        base({
          text: 'Deploys happen on Wednesdays.',
          recentTurns: ['From now on we deploy on Wednesdays.'],
        }),
      ),
    ).toBeNull();
    expect(refusalText(r as NoteRefusal)).toContain('Do this:');
    // an ask about one thing does not cover the statements that follow it; a standing request does
    const earlier = [
      'Remember: releases happen on Thursdays.',
      'The staging build finished at noon.',
    ];
    expect(code(base({ text: 'The staging build finished at noon.', recentTurns: earlier }))).toBe(
      'unasked',
    );
    expect(
      code(base({ text: 'Releases happen on Thursdays.', recentTurns: earlier.slice(0, 1) })),
    ).toBeNull();
    expect(
      code(
        base({
          text: 'The staging build finished at noon.',
          recentTurns: ['Remember everything I tell you about the release.', ...earlier.slice(1)],
        }),
      ),
    ).toBeNull();
  });

  it('a correction may replace a held value above the threshold; the same value word for word stays a duplicate', () => {
    const held = { text: 'The release code name is bench-1a2b3c4d5e6f.', score: 0.9 };
    const correction =
      'Correction: the release code name is bench-9f8e7d6c5b4a, forget the first one.';
    expect(
      code(
        base({
          text: 'The release code name is bench-9f8e7d6c5b4a.',
          recentTurns: [correction],
          existingNotes: [held],
        }),
      ),
    ).toBeNull();
    expect(
      code(
        base({
          text: 'The release code name is bench-1a2b3c4d5e6f.',
          recentTurns: [correction],
          existingNotes: [held],
        }),
      ),
    ).toBe('duplicate');
    expect(
      code(
        base({
          text: 'The release code name is bench-9f8e7d6c5b4a.',
          recentTurns: ['Remember: the release code name is bench-9f8e7d6c5b4a.'],
          existingNotes: [held],
        }),
      ),
    ).toBe('duplicate');
    // one changed word in a long note overlaps its twin above 0.9 and is still the correction
    const long = (day: string) =>
      `The production deployment window for the main customer service in our European region is every week on ${day} at 14:00 UTC.`;
    const said = 'Correction: we deploy on Thursday now, not Wednesday.';
    const twinNote = { text: long('Wednesday'), score: 0.97 };
    expect(
      code(base({ text: long('Thursday'), recentTurns: [said], existingNotes: [twinNote] })),
    ).toBeNull();
    expect(
      code(base({ text: long('Wednesday'), recentTurns: [said], existingNotes: [twinNote] })),
    ).toBe('duplicate');
  });
});
