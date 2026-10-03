import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const { boundaryOf, readPark } = await import('./park-view.js');
const { announcesAMove, buildLeaveBody, buildTransitionReasonBody } = await import(
  './transition-reason.js'
);

const at = (minute: number) => new Date(Date.UTC(2026, 8, 27, 10, minute));

const parkBody = (kind: string, left: string, why = 'why it stopped') =>
  [
    '## Park',
    '',
    '```forge-record',
    `kind: ${kind}`,
    `why: ${why}`,
    `left: ${left}`,
    '```',
    '',
    '`forge-record: park · contract 1`',
  ].join('\n');

const questionBody = (...readings: string[]) =>
  [
    '## Question',
    '',
    '```forge-record',
    ...readings.map((r) => `reading: ${r}`),
    '```',
    '',
    '`forge-record: question · contract 1`',
  ].join('\n');

describe('boundaryOf — the transition that preceded the park', () => {
  it('is the newest move into a working status, skipping moves into the parks', () => {
    const moves = [
      { to: 'needs_info', at: at(30), reason: null },
      { to: 'on_hold', at: at(20), reason: null },
      { to: 'in_progress', at: at(10), reason: null },
      { to: 'open', at: at(5), reason: null },
    ];
    expect(boundaryOf(moves)).toEqual(at(10));
  });

  it('is null where the history holds no working status', () => {
    expect(boundaryOf([{ to: 'needs_info', at: at(3), reason: null }])).toBeNull();
    expect(boundaryOf([])).toBeNull();
  });
});

describe('readPark — the resume status is the work state’s left status (ISS-54)', () => {
  it('resumes where the park left, pairing the park record and the kind it owes', () => {
    const park = readPark({
      status: 'needs_info',
      waitingKind: 'needs_decision',
      leftStatus: 'in_progress',
      moves: [
        { to: 'needs_info', at: at(20), reason: 'parked for a person' },
        { to: 'in_progress', at: at(10), reason: null },
      ],
      comments: [{ id: 'c1', body: parkBody('screen-review', 'developed'), createdAt: at(21) }],
      openHumanQuestionIds: [],
    });
    expect(park?.resume).toEqual({ at: 'in_progress', recordId: 'c1' });
    expect(park?.owes).toBe('decision');
    expect(park?.since).toBe(at(20).toISOString());
    expect(park?.reason).toBe('parked for a person');
    expect(park?.record).toMatchObject({ commentId: 'c1', kind: 'screen-review' });
  });

  it('pairs a needs_info record written just before the move, with the readings of its question', () => {
    const park = readPark({
      status: 'needs_info',
      waitingKind: 'needs_answer',
      leftStatus: 'approved',
      moves: [
        { to: 'needs_info', at: at(20), reason: null },
        { to: 'approved', at: at(10), reason: null },
      ],
      comments: [
        { id: 'q1', body: questionBody('A -> ship it', 'B -> hold it'), createdAt: at(18) },
        { id: 'c1', body: parkBody('question', 'approved'), createdAt: at(19) },
      ],
      openHumanQuestionIds: [],
    });
    expect(park?.resume).toEqual({ at: 'approved', recordId: 'c1' });
    expect(park?.readings).toEqual(['A -> ship it', 'B -> hold it']);
    expect(park?.owes).toBe('information');
  });

  it('takes the newest record where the episode holds two', () => {
    const park = readPark({
      status: 'needs_info',
      waitingKind: 'needs_answer',
      leftStatus: 'approved',
      moves: [{ to: 'needs_info', at: at(30), reason: null }],
      comments: [
        { id: 'old', body: parkBody('screen-review', 'developed'), createdAt: at(5) },
        { id: 'new', body: parkBody('question', 'approved'), createdAt: at(25) },
      ],
      openHumanQuestionIds: [],
    });
    expect(park?.resume).toEqual({ at: 'approved', recordId: 'new' });
  });

  it('never takes the resume status from a record’s `left` — the work state is the only source', () => {
    const park = readPark({
      status: 'needs_info',
      waitingKind: 'needs_resource',
      leftStatus: 'awaiting_release',
      moves: [],
      comments: [{ id: 'c1', body: parkBody('blocked', 'open'), createdAt: at(1) }],
      openHumanQuestionIds: [],
    });
    expect(park?.resume).toEqual({ at: 'awaiting_release', recordId: 'c1' });
  });

  it('never defaults a status: with no left status recorded it says why', () => {
    const park = readPark({
      status: 'needs_info',
      waitingKind: 'needs_answer',
      leftStatus: null,
      moves: [
        { to: 'needs_info', at: at(20), reason: 'set outright' },
        { to: 'in_progress', at: at(10), reason: null },
      ],
      comments: [{ id: 'c1', body: parkBody('question', 'in_progress'), createdAt: at(21) }],
      openHumanQuestionIds: [],
    });
    expect(park?.resume.at).toBeNull();
    expect(park?.resume).toHaveProperty('why', expect.stringContaining('migration 0346'));
  });

  it('ignores a comment that only mentions a record in prose', () => {
    const park = readPark({
      status: 'needs_info',
      waitingKind: 'needs_answer',
      leftStatus: 'open',
      moves: [],
      comments: [{ id: 'c1', body: 'we wrote a forge-record: park earlier', createdAt: at(1) }],
      openHumanQuestionIds: [],
    });
    expect(park?.record).toBeNull();
    expect(park?.resume).toEqual({ at: 'open', recordId: null });
  });
});

describe('readPark — who it exists for', () => {
  it('is null at a working status with no open question', () => {
    expect(
      readPark({
        status: 'in_progress',
        waitingKind: null,
        moves: [],
        comments: [],
        openHumanQuestionIds: [],
      }),
    ).toBeNull();
  });

  it('is a question at a working status holding an open human question, with nothing to resume', () => {
    const park = readPark({
      status: 'in_progress',
      waitingKind: null,
      moves: [],
      comments: [],
      openHumanQuestionIds: ['q1'],
    });
    expect(park).toMatchObject({ shape: 'question', owes: 'information', openQuestionIds: ['q1'] });
    expect(park?.resume.at).toBeNull();
  });

  it('names a needs_info park’s owes from its stored kind', () => {
    const owes = (waitingKind: 'needs_answer' | 'needs_decision' | 'needs_resource') =>
      readPark({
        status: 'needs_info',
        waitingKind,
        leftStatus: 'open',
        moves: [],
        comments: [],
        openHumanQuestionIds: [],
      })?.owes;
    expect(owes('needs_decision')).toBe('decision');
    expect(owes('needs_resource')).toBe('resource');
    expect(owes('needs_answer')).toBe('information');
  });
});

describe('readPark — the answer a person gave in the thread', () => {
  const base = {
    status: 'needs_info' as const,
    waitingKind: 'needs_answer' as const,
    leftStatus: 'in_progress' as const,
    moves: [{ to: 'needs_info', at: at(20), reason: 'should the export keep the order?' }],
    comments: [{ id: 'rec', body: parkBody('question', 'in_progress'), createdAt: at(19) }],
    openHumanQuestionIds: [],
  };
  const answerOf = (
    replies: Array<{ id: string; body: string; minute: number; byDevice?: boolean }>,
  ) =>
    readPark({
      ...base,
      replies: replies.map((r) => ({
        id: r.id,
        body: r.body,
        createdAt: at(r.minute),
        byDevice: r.byDevice ?? false,
      })),
    })?.answer;

  it('is the newest comment a person posted after the park record', () => {
    expect(
      answerOf([
        { id: 'a1', body: 'keep it', minute: 22 },
        { id: 'a2', body: 'no, change it', minute: 25 },
      ]),
    ).toEqual({ commentId: 'a2', postedAt: at(25).toISOString(), text: 'no, change it' });
  });

  it('is not a comment from before the record, a device’s, the move’s announcement or a typed record', () => {
    expect(
      answerOf([
        { id: 'before', body: 'early word', minute: 18 },
        { id: 'device', body: 'a run said this', minute: 22, byDevice: true },
        { id: 'ann', body: '❓ **Needs info** — moved from `in_progress`\n\nwhy', minute: 20 },
        { id: 'rec2', body: questionBody('A -> x', 'B -> y'), minute: 23 },
      ]),
    ).toBeNull();
  });

  it('is an answer record relaying one, whoever posted it', () => {
    const relayed = [
      '## Answer',
      '',
      '```forge-record',
      'said: keep it',
      '```',
      '',
      '`forge-record: answer · contract 1`',
    ].join('\n');
    expect(answerOf([{ id: 'rel', body: relayed, minute: 24, byDevice: true }])?.commentId).toBe(
      'rel',
    );
  });

  it('carries the whole answer, however long, so nothing after a cut is lost', () => {
    const long = `${'a'.repeat(3000)} — but only on Tuesdays`;
    expect(answerOf([{ id: 'a1', body: long, minute: 22 }])?.text).toBe(long);
  });

  it('is null where no park record was posted', () => {
    const park = readPark({
      ...base,
      comments: [],
      replies: [{ id: 'a1', body: 'keep it', createdAt: at(22) }],
    });
    expect(park?.answer).toBeNull();
  });
});

describe('announcesAMove — the announcements an answer is never read from', () => {
  it('knows every heading the announcement writers produce', () => {
    for (const body of [
      buildTransitionReasonBody('needs_info', 'in_progress', 'which order?'),
      buildTransitionReasonBody('needs_info', 'in_progress', 'look at it', 'needs_decision'),
      buildTransitionReasonBody('needs_info', 'approved', 'an account', 'needs_resource'),
      buildTransitionReasonBody('on_hold', 'open', 'freeze week'),
      buildTransitionReasonBody('reopen', 'awaiting_release', 'criterion 2 failed'),
      buildTransitionReasonBody('dropped', 'open', 'a duplicate'),
      buildLeaveBody('needs_info', 'in_progress', 'settled on the call'),
    ]) {
      expect(announcesAMove(body), body).toBe(true);
    }
  });

  it('is false for what a person writes, even one that mentions a move', () => {
    for (const body of [
      'keep the legacy order',
      'it moved from `in_progress` yesterday, keep it',
    ]) {
      expect(announcesAMove(body), body).toBe(false);
    }
  });

  it('keeps a leave announcement from reading as the answer', () => {
    const park = readPark({
      status: 'needs_info',
      waitingKind: 'needs_answer',
      leftStatus: 'in_progress',
      moves: [{ to: 'needs_info', at: at(20), reason: 'which order?' }],
      comments: [{ id: 'rec', body: parkBody('question', 'in_progress'), createdAt: at(19) }],
      replies: [
        { id: 'leave', body: buildLeaveBody('on_hold', 'needs_info', 'why'), createdAt: at(21) },
      ],
      openHumanQuestionIds: [],
    });
    expect(park?.answer).toBeNull();
  });
});
