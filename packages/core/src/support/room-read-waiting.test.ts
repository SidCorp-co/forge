// @direct-test-of packages/core/src/support/room-read-words.ts
// ISS-1483 (dev.863): a room is handed what an issue waits on from its kind, never from the words an
// agent wrote. A park's question IS its text (`issues/park-question.ts:mintParkQuestion`), so the read
// plants an agent-written one and renders every park kind through the real functions.
import { describe, expect, it } from 'vitest';
import type { OpenPersonQuestion } from '../questions/index.js';
import { questionOf } from './ops-waiting.js';
import { NEUTRAL_ASK, parkReasonOf, QUESTION_WORDS_WITHHELD } from './room-read-words.js';
import { INTERNAL_WORDS, NAMES_THE_HAND, NEUTRAL_PARK } from './room-voice.js';

describe('what a parked issue waits on, as a room reads it (ISS-1483)', () => {
  it('hand a parked issue no park text, only its kind in plain terms', () => {
    // every kind a park carries, so a new kind is covered by the same rule
    for (const kind of [
      'answer',
      'decision',
      'resource',
      'issue',
      'none',
      'master',
      'run',
      'judge',
      'gate',
      'machine',
      'system',
      'project',
      'you',
      'person',
      'admins',
      'writers',
    ]) {
      for (const behind of [null, { title: null }, { title: 'Sign-in page' }]) {
        const said = parkReasonOf(kind, behind);
        expect(NAMES_THE_HAND.test(said) || INTERNAL_WORDS.test(said), `${kind}: ${said}`).toBe(
          false,
        );
        expect(said, kind).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
      }
    }
    expect(parkReasonOf('answer', null)).toBe(NEUTRAL_ASK);
    expect(parkReasonOf('master', null)).toBe(NEUTRAL_PARK);
    // another issue is named by its title as a person knows it, never by its key
    expect(parkReasonOf('issue', { title: 'Sign-in page' })).toBe(
      'it is waiting for "Sign-in page" to move on',
    );
    expect(parkReasonOf('issue', { title: 'ISS-12 the master fixes it' })).toBe(
      'it is waiting behind another issue to move on',
    );
  });

  it("hand no agent's question words to a room, through the real read, and keep a person's", () => {
    const written =
      'ISS-1428 refused PAT_PROJECT_OUTSIDE_FENCE at 9e174d4534ab: the orchestrator runs it, their masters, the judge';
    const step = (extra: object) => ({
      answerShape: 'free_text',
      prompt: written,
      needed: `have the master quote ${written}`,
      recommended: 'ask the steward',
      ...extra,
    });
    const row = (current: object, askedBy: string | null) =>
      ({
        id: 'q1',
        issueId: 'i1',
        askedBy,
        current,
        at: '2026-11-28T00:00:00.000Z',
      }) as unknown as OpenPersonQuestion;
    // asked by a park (no asking account) or an agent account: the words never reach the room
    {
      const out = questionOf(row(step({}), null), false);
      const said = JSON.stringify(out);
      expect(said).not.toMatch(NAMES_THE_HAND);
      expect(said).not.toMatch(INTERNAL_WORDS);
      expect(said).not.toMatch(/ISS-1428|PAT_PROJECT|9e174d4|orchestrator/);
      expect(out.asks).toBe(NEUTRAL_ASK);
      expect(out.needed).toBeNull();
      expect(out.recommended).toBeNull();
      expect(out.withheld).toBe(QUESTION_WORDS_WITHHELD);
    }
    const choice = questionOf(
      row(
        {
          answerShape: 'choice',
          prompt: written,
          options: [
            { id: 'a', label: 'Ask the master to retry' },
            { id: 'b', label: 'Keep the sign-in page' },
          ],
        },
        null,
      ),
      false,
    );
    // an agent's choice labels are never handed on: each option reads by its place
    expect(choice.options.map((o) => o.says)).toEqual(['option 1', 'option 2']);
    expect(JSON.stringify(choice)).not.toMatch(NAMES_THE_HAND);
    expect(JSON.stringify(choice)).not.toMatch(INTERNAL_WORDS);
    // a question a person asked is addressed to a person and stays as written
    const person = questionOf(
      row(step({ prompt: 'Which tour do you want?', needed: 'a file' }), 'u1'),
      true,
    );
    expect(person).toMatchObject({ asks: 'Which tour do you want?', needed: 'a file' });
    expect(person.withheld).toBeUndefined();
  });
});
