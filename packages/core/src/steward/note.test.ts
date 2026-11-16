// The note the runaway guard writes on an item whose act it refused (ISS-1255): it says what repeated
// in the words a person reads, never the act's id or the outbox event that carried the trigger
// (ISS-1137: rows on forge-dev read "did not act on feedback.filed here").
//
// @direct-test-of packages/core/src/steward/note.ts

import { say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import { STEWARD_ACTS } from '@forge/contracts/steward';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./account.js', () => ({ stewardAccountOf: async () => 'steward' }));
vi.mock('./credential.js', () => ({
  mintStewardCredential: async () => 'token',
  STEWARD_TURN_TTL_MS: 1,
}));
vi.mock('./door-call.js', () => ({ bearer: () => ({}), callDoor: async () => ({ ok: true }) }));

const { ACT_WORDS, repeatedCommentBody, repeatedNoteBody } = await import('./note.js');

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
} as unknown as Parameters<typeof repeatedNoteBody>[1];

const run = { id: 'r1', subjectKey: 'ISS-9' } as Parameters<typeof repeatedNoteBody>[0];

describe("the repeated-act note's words", () => {
  it('names each act in words and the count, never the act id', () => {
    for (const act of STEWARD_ACTS) {
      const note = repeatedNoteBody(run, standing, { act, count: 5 });
      const [first] = note.lines;
      expect(first).toContain(ACT_WORDS[act]);
      expect(first).toContain('5 times');
      if (act !== 'note') expect(first, `the note on ${act} prints its id`).not.toContain(act);
      expect(note.basis).toBe('b1');
    }
  });

  it('says it on an issue with no open standing as a comment naming the issue', () => {
    const { body } = repeatedCommentBody(run, { act: 'release_followthrough', count: 5 });
    expect(body).toContain('ISS-9');
    expect(body).toContain('the check of the shipped release');
    expect(body).not.toContain('release_followthrough');
  });
});
