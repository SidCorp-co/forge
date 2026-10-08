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
      lines: ['Why: People lose drafts.', '1. A draft survives a tab switch.'],
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
    const rest = (
      kind: Parameters<typeof summaryOfRest>[0]['kind'],
      path: string,
      body = {},
      method = 'POST',
    ) => summaryOfRest({ kind, method, path, body, attachmentName: null });
    expect(rest('comment', '/api/projects/p/requirements/REQ-30/comments', { body: 'Hi' })).toEqual(
      {
        title: 'Comment on REQ-30',
        lines: ['Hi'],
        relates: ['REQ-30'],
      },
    );
    expect(
      summaryOfRest({
        kind: 'attachment',
        method: 'POST',
        path: '/api/issues/ISS-4/attachments',
        body: {},
        attachmentName: 'log.txt',
      }),
    ).toEqual({ title: 'Attach to ISS-4', lines: ['log.txt'], relates: ['ISS-4'] });
    expect(
      rest('requirement_revision', '/api/projects/p/requirements/REQ-9/revisions').relates,
    ).toEqual(['REQ-9']);
  });

  it('an issue change: every field it would set, on the issue it names', () => {
    expect(
      summaryOfRest({
        kind: 'issue_change',
        method: 'PATCH',
        path: '/api/issues/9e7434fd-4507-42d0-bb4a-db1e25248536',
        body: { priority: 'high', title: 'Renamed by the chat' },
        attachmentName: null,
      }),
    ).toEqual({
      title: 'Change 9e7434fd-4507-42d0-bb4a-db1e25248536',
      lines: ['priority: high', 'title: Renamed by the chat'],
      relates: ['9e7434fd-4507-42d0-bb4a-db1e25248536'],
    });
  });

  it("a requirement's design link, and the designs a REST draft names", () => {
    expect(
      summaryOfRest({
        kind: 'requirement_link',
        method: 'POST',
        path: '/api/projects/p/requirements/REQ-3/workflows',
        body: { workflowId: 'w-1' },
        attachmentName: null,
      }),
    ).toEqual({ title: 'Link REQ-3 to design w-1', lines: [], relates: ['REQ-3', 'design w-1'] });
    expect(
      summaryOfRest({
        kind: 'requirement_draft',
        method: 'POST',
        path: '/api/projects/p/requirements',
        body: { title: 'T', reason: 'R', criteria: [], designs: ['chat-turn'] },
        attachmentName: null,
      }).relates,
    ).toEqual(['design chat-turn']);
  });

  it('a project change, by what it does to the project', () => {
    expect(
      summaryOfRest({
        kind: 'project_change',
        method: 'POST',
        path: '/api/projects/p/archive',
        body: {},
        attachmentName: null,
      }).title,
    ).toBe('Archive the project');
  });
});

describe('the card leaves nothing out', () => {
  it('lists every criterion, unclipped, and every field the call carries', () => {
    const long = 'x'.repeat(900);
    const s = card('forge_requirement_draft', {
      title: 'Many criteria',
      reason: long,
      criteria: Array.from({ length: 20 }, (_, i) => ({ body: `C${i + 1} holds.` })),
      tldr: 'Short.',
      spec: { openQuestions: ['Who sees it?'] },
    });
    expect(s.lines).toEqual([
      `Why: ${long}`,
      ...Array.from({ length: 20 }, (_, i) => `${i + 1}. C${i + 1} holds.`),
      'tldr: Short.',
      'spec: {"openQuestions":["Who sees it?"]}',
    ]);
  });

  it('a forge issue change: each flag with its value', () => {
    expect(
      card('forge', {
        argv: ['issue', 'ISS-12', '--set', 'priority=urgent', '--why', 'the chat asked'],
      }),
    ).toEqual({
      title: 'Change ISS-12',
      lines: ['--set priority=urgent', '--why the chat asked'],
      relates: ['ISS-12'],
    });
    expect(card('forge', { argv: ['project', 'forge', '--set', 'name=Forge 2'] })).toEqual({
      title: 'Change project forge',
      lines: ['--set name=Forge 2'],
      relates: [],
    });
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
