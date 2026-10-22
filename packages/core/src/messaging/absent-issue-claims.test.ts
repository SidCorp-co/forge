import { describe, expect, it } from 'vitest';
import { ISSUE_REFERENCES_EXIST } from './claim-rules.js';
import { NO_FACTS } from './facts.js';
import { keyMentions } from './issue-tokens.js';
import { screenAtDoor } from './screen.js';

// ISS-1229 r37, judge-100: asked to comment on ISS-999, which the project does not hold, the room's
// assistant said so and the reply check withdrew it — "reply cites ISS-999 which was not verified this
// turn" — replacing a true answer with a vaguer one that named no key.
const facts = {
  ...NO_FACTS,
  prefix: 'ISS',
  prefixes: ['ISS'],
  knownIssueSeqs: new Set([1]),
  issueRows: new Map([[1, { seq: 1, merged: false, status: 'open' }]]),
};
const room = (text: string) => screenAtDoor('web-chat-reply', [text], facts);

describe('a reply saying a key is not on the project', () => {
  it.each([
    'ISS-999 is not on the J100 desk project tracker.',
    "**ISS-999** is not on this project's tracker, so I could not add the comment.",
    "I couldn't add the comment: ISS-999 isn't in this project.",
    'There is no ISS-999 on this project.',
    "I couldn't find ISS-999 in this project's issues.",
    'ISS-999 does not exist here; the project holds ISS-1.',
    'ISS-999 is not on this project; tell me if you meant another issue.',
  ])('passes the room door where the project holds no such issue: %s', (text) => {
    expect(room(text)).toMatchObject({ ok: true });
  });

  it('passes the stakeholder door that reads every key against the tracker', () => {
    expect(ISSUE_REFERENCES_EXIST.check('There is no ISS-999 on this project.', facts)).toEqual([]);
  });

  it.each([
    'I added the comment to ISS-999.',
    'ISS-999 is not in progress yet.',
    'ISS-999 is not done, but it is on the tracker.',
  ])('still refuses a key the project does not hold, said as anything but absent: %s', (text) => {
    const verdict = room(text);
    expect(verdict.ok).toBe(false);
    expect(JSON.stringify(verdict)).toContain('ISS-999');
  });

  it('reads each naming on its own, so a key said absent once and cited again is still refused', () => {
    const mentions = keyMentions('ISS-999 is not on this project. ISS-998 is ready.', ['ISS']);
    expect(mentions.map((m) => [m.seq, m.absent])).toEqual([
      [999, true],
      [998, false],
    ]);
    expect(room('ISS-999 is not on this project. ISS-998 is ready.').ok).toBe(false);
    const both = 'ISS-999 is not on this project, but ISS-999 is ready.';
    expect(keyMentions(both, ['ISS']).map((m) => m.absent)).toEqual([true, false]);
    expect(room(both).ok).toBe(false);
    expect(ISSUE_REFERENCES_EXIST.check(both, facts).map((b) => b.quote)).toEqual(['ISS-999']);
  });

  // The whole-set read of round 37 (F1): a narrower scope, a question and a condition assert no absence.
  it.each([
    'ISS-999 is not on the current sprint backlog.',
    "ISS-999 isn't in this project's release list.",
  ])(
    'still refuses a missing key said absent from something narrower than the project: %s',
    (text) => {
      expect(room(text).ok).toBe(false);
      expect(ISSUE_REFERENCES_EXIST.check(text, facts)).toHaveLength(1);
    },
  );

  // The second whole-set read of round 37: a scope named before the key, and a past time, assert no
  // present absence from the project.
  it.each([
    ["In the current sprint, I couldn't find ISS-1.", true],
    ["In the current sprint, I couldn't find ISS-999.", false],
    ['ISS-1 was not on this project yesterday.', true],
    ['ISS-999 was not on this project yesterday.', false],
    ['ISS-999 is no longer on this project as of last week.', false],
  ])('reads %s as no present absence from the project', (text, passes) => {
    expect(keyMentions(text, ['ISS']).every((m) => !m.absent)).toBe(true);
    expect(room(text).ok).toBe(passes);
  });

  it('reads a question or a condition about a held key as no claim that it is absent', () => {
    expect(room('What if ISS-1 is not on this project?').ok).toBe(true);
    for (const asked of ['**ISS-1 is not on this project?**', '"ISS-1 is not on this project?"']) {
      expect(keyMentions(asked, ['ISS'])[0]?.absent).toBe(false);
      expect(room(asked).ok).toBe(true);
      expect(room(asked.replace('ISS-1', 'ISS-999')).ok).toBe(false);
      expect(ISSUE_REFERENCES_EXIST.check(asked.replace('ISS-1', 'ISS-999'), facts)).toHaveLength(
        1,
      );
    }
    expect(room('If ISS-1 is not on this project, I can file it.').ok).toBe(true);
    expect(room('ISS-1 is not on this project if the import failed.').ok).toBe(true);
    expect(room('ISS-1 is not on this project, if the import failed.').ok).toBe(true);
    expect(room('ISS-1 is not on this project, unless it was moved.').ok).toBe(true);
    for (const lead of ['Assuming', 'Provided that']) {
      expect(
        keyMentions(`${lead} ISS-1 is not on this project, I can file it.`, ['ISS'])[0]?.absent,
      ).toBe(false);
      expect(room(`${lead} ISS-1 is not on this project, I can file it.`).ok).toBe(true);
      expect(room(`${lead} ISS-999 is not on this project, I can file it.`).ok).toBe(false);
    }
    expect(room('ISS-999 is not on this project if the import failed.').ok).toBe(false);
  });

  it('refuses saying the project does not hold an issue it holds', () => {
    const verdict = room('ISS-1 is not on this project.');
    expect(verdict.ok).toBe(false);
    expect(JSON.stringify(verdict)).toContain(
      'reply says ISS-1 is not on this project, and this project holds it',
    );
    expect(ISSUE_REFERENCES_EXIST.check('There is no ISS-1 on this project.', facts)).toHaveLength(
      1,
    );
  });
});
