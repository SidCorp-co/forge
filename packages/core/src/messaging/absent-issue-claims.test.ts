import { describe, expect, it } from 'vitest';
import { ISSUE_REFERENCES_EXIST } from './claim-rules.js';
import { NO_FACTS } from './facts.js';
import { absentIssueSeqs } from './issue-tokens.js';
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

  it('reads absence per sentence, so a key absent in one is still cited in another', () => {
    expect([
      ...absentIssueSeqs('ISS-999 is not on this project. ISS-998 is ready.', ['ISS']),
    ]).toEqual([999]);
    expect(room('ISS-999 is not on this project. ISS-998 is ready.').ok).toBe(false);
  });
});
