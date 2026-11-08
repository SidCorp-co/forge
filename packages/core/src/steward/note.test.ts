// The note the cost guard writes on an item it could not act on (REQ-48): it says what waited in the
// words a person reads, never the outbox event that carried the trigger (ISS-1137: rows on forge-dev
// read "did not act on feedback.filed here").
//
// @direct-test-of packages/core/src/steward/note.ts

import { say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import { STEWARD_TRIGGERS } from '@forge/contracts/steward';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./account.js', () => ({ stewardAccountOf: async () => 'steward' }));
vi.mock('./credential.js', () => ({
  mintStewardCredential: async () => 'token',
  STEWARD_TURN_TTL_MS: 1,
}));
vi.mock('./door-call.js', () => ({ bearer: () => ({}), callDoor: async () => ({ ok: true }) }));

const { budgetNoteBody, TRIGGER_WORDS } = await import('./note.js');

const standing = {
  subject: { kind: 'feedback', key: 'FB-559' },
  title: 'Export is empty',
  group: 'waiting_on_others',
  waitingOn: waitingOn('master', {
    who: say('standing.who.master'),
    act: say('standing.act.none'),
    rule: say('standing.act.none'),
  }),
  note: null,
  stuck: null,
  dueAt: null,
  carriedBy: null,
  basis: 'b1',
} as unknown as Parameters<typeof budgetNoteBody>[1];

describe("the budget note's words", () => {
  it('names what waited in words, never the event that carried the trigger', () => {
    for (const trigger of STEWARD_TRIGGERS) {
      const [first] = budgetNoteBody(
        { id: 'r1', trigger } as Parameters<typeof budgetNoteBody>[0],
        standing,
      ).lines;
      expect(first).toContain(TRIGGER_WORDS[trigger]);
      expect(first, `the note on ${trigger} prints its event name`).not.toContain(trigger);
    }
  });

  it('reads the new feedback as a person would', () => {
    const [first] = budgetNoteBody(
      { id: 'r1', trigger: 'feedback.filed' } as Parameters<typeof budgetNoteBody>[0],
      standing,
    ).lines;
    expect(first).toBe(
      "The steward's daily budget for this project is spent, so it did not act on the new feedback here.",
    );
  });
});
