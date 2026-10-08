// What a confirm card shows is read from the held call itself, so the record and what it relates
// to are the ones core will write (REQ-30 BC-4: it names which existing requirement, feedback or
// design the record relates to).

import { describe, expect, it } from 'vitest';
import { kindOfToolCall, recordRefOf, summaryOfRest, summaryOfToolCall } from './summary.js';

const card = (name: string, args: unknown) => {
  const json = JSON.stringify(args);
  return summaryOfToolCall(kindOfToolCall(name, json), name, json);
};

describe('the card names what a held Assistant call would record, and what it links to', () => {
  it('Feedback: its kind, title, body, and the one target it links', () => {
    expect(
      card('forge_feedback', {
        kind: 'bug',
        title: 'The dock loses my draft',
        body: 'Switching tabs clears it.',
        requirement: 'REQ-30',
      }),
    ).toEqual({
      title: 'Feedback (bug): The dock loses my draft',
      lines: ['Switching tabs clears it.'],
      relates: ['REQ-30'],
    });
    expect(
      card('forge_feedback', { kind: 'idea', title: 'x', workflow: 'chat-turn' }).relates,
    ).toEqual(['workflow chat-turn']);
  });

  it('a draft Requirement: its criteria, and the designs it links', () => {
    const s = card('forge_requirement_draft', {
      title: 'Keep chat drafts',
      reason: 'People lose drafts.',
      criteria: [{ body: 'A draft survives a tab switch.' }],
      designs: ['chat-turn'],
    });
    expect(s).toEqual({
      title: 'New requirement: Keep chat drafts',
      lines: ['Why: People lose drafts.', 'A draft survives a tab switch.'],
      relates: ['design chat-turn'],
    });
    expect(
      card('forge_requirement_draft', {
        title: 'From the spec',
        criteria: [],
        criteriaFrom: { file: 'spec.md', section: 'Acceptance' },
      }).lines,
    ).toEqual(['Criteria from spec.md, section "Acceptance"']);
  });

  it('a revision links its requirement; a comment and an attachment their issue', () => {
    expect(
      card('forge_requirement_revise', { requirement: 'REQ-30', reason: 'r' }).relates,
    ).toEqual(['REQ-30']);
    expect(card('forge', { argv: ['comment', 'ISS-12', '-'], body: 'Seen again' })).toEqual({
      title: 'Comment on ISS-12',
      lines: ['Seen again'],
      relates: ['ISS-12'],
    });
    expect(card('forge', { argv: ['attach', 'issue', 'ISS-12', '/tmp/x/shot.png'] })).toEqual({
      title: 'Attach to ISS-12',
      lines: ['shot.png'],
      relates: ['ISS-12'],
    });
  });

  it('refuses to guess a kind for a write it does not know, loudly', () => {
    expect(() => kindOfToolCall('forge_unknown', '{}')).toThrow(/no kind of record names it/);
  });
});

describe('the card names what a held Agent request would record', () => {
  it('reads the record from the body and the target from the path', () => {
    expect(
      summaryOfRest(
        'comment',
        '/api/projects/p/requirements/REQ-30/comments',
        { body: 'Hi' },
        null,
      ),
    ).toEqual({ title: 'Comment on REQ-30', lines: ['Hi'], relates: ['REQ-30'] });
    expect(summaryOfRest('attachment', '/api/issues/ISS-4/attachments', {}, 'log.txt')).toEqual({
      title: 'Attach to ISS-4',
      lines: ['log.txt'],
      relates: ['ISS-4'],
    });
    expect(
      summaryOfRest(
        'requirement_revision',
        '/api/projects/p/requirements/REQ-9/revisions',
        {},
        null,
      ).relates,
    ).toEqual(['REQ-9']);
  });
});

describe('the key a write answered with', () => {
  it('reads Feedback, a draft and a revision', () => {
    expect(recordRefOf('feedback', { feedback: { key: 'FB-3' } })).toBe('FB-3');
    expect(recordRefOf('requirement_draft', { requirement: { key: 'REQ-4' } })).toBe('REQ-4');
    expect(
      recordRefOf('requirement_revision', {
        key: 'REQ-4',
        revisions: [{ revision: 1 }, { revision: 2 }],
      }),
    ).toBe('REQ-4 r2');
  });
});
