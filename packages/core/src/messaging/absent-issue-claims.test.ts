import { describe, expect, it } from 'vitest';
import { ISSUE_REFERENCES_EXIST } from './claim-rules.js';
import { NO_FACTS } from './facts.js';
import { keyMentions } from './issue-tokens.js';
import { plainQuotes } from './plain-quotes.js';
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

  // The sixth whole-set read: a clause that does not open on the key or on "there is no" is not read.
  // The seventh: a condition on the line before, and something else named absent after the key.
  it.each([
    'If the import failed,\nISS-$ is not on this project.',
    'There is no ISS-$ comment on this project.',
    'ISS-$ is not on this project\nif the import failed.',
    'ISS-$ is not on this project; only if the import failed.',
  ])('reads %s as no claim that the key is absent', (shape) => {
    expect(keyMentions(shape.replaceAll('$', '1'), ['ISS'])[0]?.absent).toBe(false);
    expect(room(shape.replaceAll('$', '1')).ok).toBe(true);
    expect(room(shape.replaceAll('$', '999')).ok).toBe(false);
    expect(ISSUE_REFERENCES_EXIST.check(shape.replaceAll('$', '999'), facts)).toHaveLength(1);
  });

  it('reads a negated absence as no claim that the key is absent', () => {
    const negated = (key: string) => `It is not true that there is no ${key} on this project.`;
    expect(keyMentions(negated('ISS-1'), ['ISS'])[0]?.absent).toBe(false);
    expect(room(negated('ISS-1')).ok).toBe(true);
    expect(room(negated('ISS-999')).ok).toBe(false);
    expect(ISSUE_REFERENCES_EXIST.check(negated('ISS-999'), facts)).toHaveLength(1);
  });

  it('reads a question or a condition about a held key as no claim that it is absent', () => {
    expect(room('What if ISS-1 is not on this project?').ok).toBe(true);
    for (const asked of [
      '**ISS-1 is not on this project?**',
      '"ISS-1 is not on this project?"',
      '**ISS-1 is not on this project?** I can check.',
      '"ISS-1 is not on this project?" I can check.',
    ]) {
      expect(keyMentions(asked, ['ISS'])[0]?.absent).toBe(false);
      expect(room(asked).ok).toBe(true);
      expect(room(asked.replaceAll('ISS-1', 'ISS-999')).ok).toBe(false);
      expect(
        ISSUE_REFERENCES_EXIST.check(asked.replaceAll('ISS-1', 'ISS-999'), facts),
      ).toHaveLength(1);
    }
    expect(room('If ISS-1 is not on this project, I can file it.').ok).toBe(true);
    expect(room('ISS-1 is not on this project if the import failed.').ok).toBe(true);
    expect(room('ISS-1 is not on this project, if the import failed.').ok).toBe(true);
    expect(room('ISS-1 is not on this project, unless it was moved.').ok).toBe(true);
    for (const lead of ['If the import failed,', 'Assuming the import failed,']) {
      expect(keyMentions(`${lead} ISS-1 is not on this project.`, ['ISS'])[0]?.absent).toBe(false);
      expect(room(`${lead} ISS-1 is not on this project.`).ok).toBe(true);
      expect(room(`${lead} ISS-999 is not on this project.`).ok).toBe(false);
      expect(
        ISSUE_REFERENCES_EXIST.check(`${lead} ISS-999 is not on this project.`, facts),
      ).toHaveLength(1);
    }
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

// ISS-1229 r38, judge-103: the assistant's true reply "ISS-999 isn’t on this project’s tracker" was
// withdrawn again, because the absence patterns read only the straight apostrophe, which the assistant
// does not write. Every shape is tried in every apostrophe and quote a writer can type.
const APOSTROPHES = ["'", '\u2019', '\u2018', '\u02BC', '\uFF07', '\u2032', '\u00B4'];
const spelled = (text: string) => APOSTROPHES.map((a) => text.replaceAll("'", a));

describe('a reply saying a key is absent, whichever apostrophe it is written with', () => {
  it('keeps the reply judge-103 saw withdrawn, as the assistant wrote it', () => {
    const said =
      'ISS-999 isn\u2019t on this project\u2019s tracker, so I couldn\u2019t add the comment. The only issue here is ISS-1 (\u201cInvoice footer shows last year\u201d).';
    expect(keyMentions(said, ['ISS']).map((m) => [m.seq, m.absent])).toEqual([
      [999, true],
      [1, false],
    ]);
    expect(room(said)).toMatchObject({ ok: true });
  });

  it.each([
    "ISS-$ isn't on this project's tracker.",
    "ISS-$ doesn't exist in this project.",
    "ISS-$ wasn't found.",
    "ISS-$ couldn't be found.",
    "ISS-$ can't be found on this project's tracker.",
    "There's no ISS-$ on this project.",
    "There isn't an ISS-$ on this project's tracker.",
    "I couldn't find ISS-$ in this project's issues.",
    "I can't find ISS-$ here.",
    "I didn't find ISS-$ on this project.",
    "'ISS-$' isn't on this project.",
    '"ISS-$" isn\'t on this project.',
  ])('reads %s as the same absence in every spelling', (shape) => {
    for (const text of [
      ...spelled(shape),
      shape.replaceAll('"', '\u201c').replace('\u201c ', '\u201d '),
    ]) {
      expect(keyMentions(text.replaceAll('$', '999'), ['ISS'])[0]?.absent).toBe(true);
      expect(room(text.replaceAll('$', '999')).ok).toBe(true);
      expect(ISSUE_REFERENCES_EXIST.check(text.replaceAll('$', '999'), facts)).toEqual([]);
      expect(room(text.replaceAll('$', '1')).ok).toBe(false);
    }
  });

  it('still reads a question, a narrower scope or a past time as no absence in every spelling', () => {
    for (const shape of [
      "ISS-999 isn't on this project?",
      "ISS-999 isn't in this project's release list.",
      "ISS-999 wasn't on this project's tracker yesterday.",
      "If the import failed, ISS-999 isn't on this project.",
    ]) {
      for (const text of spelled(shape)) {
        expect(keyMentions(text, ['ISS'])[0]?.absent).toBe(false);
        expect(room(text).ok).toBe(false);
      }
    }
  });

  it('makes every mark plain one unit for one, so an index into the plain text is one into the written', () => {
    const written =
      '\u2018ISS-9\u2019 isn\u02BCt \u201con\u201d this project\uFF07s tracker\u2032\u00B4\u201A\u201B\u201E\u201F\u2033\uFF02';
    const plain = plainQuotes(written);
    expect(plain).toBe(`'ISS-9' isn't "on" this project's tracker''''""""`);
    expect(plain).toHaveLength(written.length);
  });

  it('quotes a refused key as it was written', () => {
    const said = 'ISS-999 isn\u2019t done yet.';
    expect(keyMentions(said, ['ISS'])[0]?.token).toBe('ISS-999');
    expect(ISSUE_REFERENCES_EXIST.check(said, facts).map((b) => b.quote)).toEqual(['ISS-999']);
  });
});

// ISS-1229 r39, judge-107 at 7d4a69d: the assistant's true reply "ISS-999 is not in the J107 desk
// tracker, so I couldn’t add the comment. This project currently has one issue, and it is not ISS-999."
// was withdrawn, because "and it is not ISS-999" opens on neither the key nor "there is no".
describe('a reply denying a key after saying which issues the project holds', () => {
  it('keeps the reply judge-107 saw withdrawn, in every apostrophe', () => {
    const said =
      "ISS-999 is not in the J107 desk tracker, so I couldn't add the comment. This project currently has one issue, and it is not ISS-999.";
    for (const text of spelled(said)) {
      expect(keyMentions(text, ['ISS']).map((m) => [m.seq, m.absent])).toEqual([
        [999, true],
        [999, true],
      ]);
      expect(room(text)).toMatchObject({ ok: true });
      expect(ISSUE_REFERENCES_EXIST.check(text, facts)).toEqual([]);
    }
  });

  it.each([
    'This project currently has one issue, and it is not ISS-$.',
    "This project has one issue, and it isn't ISS-$.",
    'The only issue here is ISS-1, not ISS-$.',
    'This project holds two issues, but neither of them is ISS-$.',
    "The project's only issue is ISS-1. It is not ISS-$.",
    'This project has one issue. That one is not ISS-$.',
    'ISS-1 is open, while ISS-$ is not on this project.',
    'ISS-1 is open, although ISS-$ does not exist here.',
    'I left the comment unwritten, because there is no ISS-$ on this project.',
    'ISS-1 is open, yet ISS-$ is not on this project.',
  ])('reads %s as an absence, compound or across sentences', (shape) => {
    for (const text of spelled(shape.replaceAll('$', '999'))) {
      const mention = keyMentions(text, ['ISS']).find((m) => m.seq === 999);
      expect(mention?.absent).toBe(true);
      expect(room(text).ok).toBe(true);
    }
  });

  it('still withdraws the same denial about a key the project holds', () => {
    for (const text of [
      'This project currently has one issue, and it is not ISS-1.',
      "This project has one issue. It isn't ISS-1.",
    ]) {
      expect(keyMentions(text, ['ISS'])[0]?.absent).toBe(true);
      expect(room(text).ok).toBe(false);
    }
  });

  // Consult F1 on the round-39 plan: a denial of identity with no statement of the project's issues
  // says nothing of the project, so a key it holds stays a citation it may make.
  it('reads "this one is not ISS-7" alone as no absence', () => {
    const both = {
      ...facts,
      knownIssueSeqs: new Set([7, 8]),
      issueRows: new Map([
        [7, { seq: 7, merged: false, status: 'open' }],
        [8, { seq: 8, merged: false, status: 'open' }],
      ]),
    };
    const text = 'ISS-8 is the invoice issue. This one is not ISS-7.';
    expect(keyMentions(text, ['ISS']).map((m) => m.absent)).toEqual([false, false]);
    expect(screenAtDoor('web-chat-reply', [text], both).ok).toBe(true);
    expect(room('ISS-1 is the invoice issue. This one is not ISS-999.').ok).toBe(false);
  });

  it('reads an alternative as no absence', () => {
    const text = "Either the key is wrong, or ISS-999 isn't on this project.";
    expect(keyMentions(text, ['ISS'])[0]?.absent).toBe(false);
    expect(room(text).ok).toBe(false);
  });
});
