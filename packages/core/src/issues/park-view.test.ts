import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const { boundaryOf, readPark } = await import('./park-view.js');

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
  it('is the newest move into a working rung, skipping moves into side statuses', () => {
    const moves = [
      { to: 'needs_info', at: at(30), reason: null },
      { to: 'waiting', at: at(20), reason: null },
      { to: 'developed', at: at(10), reason: null },
      { to: 'in_progress', at: at(5), reason: null },
    ];
    expect(boundaryOf(moves)).toEqual(at(10));
  });

  it('is null where the history holds no working rung', () => {
    expect(boundaryOf([{ to: 'needs_info', at: at(3), reason: null }])).toBeNull();
    expect(boundaryOf([])).toBeNull();
  });
});

describe('readPark — the resume rung is the park record’s own `left`', () => {
  it('reads sid-desk ISS-529’s shape: a waiting park that left developed resumes at developed', () => {
    const park = readPark({
      status: 'waiting',
      waitingKind: 'needs_decision',
      moves: [
        { to: 'waiting', at: at(20), reason: 'parked for a person' },
        { to: 'developed', at: at(10), reason: null },
      ],
      comments: [{ id: 'c1', body: parkBody('screen-review', 'developed'), createdAt: at(21) }],
      openHumanQuestionIds: [],
    });
    expect(park?.resume).toEqual({ at: 'developed', recordId: 'c1' });
    expect(park?.owes).toBe('decision');
    expect(park?.since).toBe(at(20).toISOString());
    expect(park?.reason).toBe('parked for a person');
    expect(park?.record).toMatchObject({ commentId: 'c1', kind: 'screen-review' });
  });

  it('pairs a needs_info record written just before the move, with the readings of its question', () => {
    const park = readPark({
      status: 'needs_info',
      waitingKind: null,
      moves: [
        { to: 'needs_info', at: at(20), reason: null },
        { to: 'confirmed', at: at(10), reason: null },
      ],
      comments: [
        { id: 'q1', body: questionBody('A -> ship it', 'B -> hold it'), createdAt: at(18) },
        { id: 'c1', body: parkBody('question', 'confirmed'), createdAt: at(19) },
      ],
      openHumanQuestionIds: [],
    });
    expect(park?.resume).toEqual({ at: 'confirmed', recordId: 'c1' });
    expect(park?.readings).toEqual(['A -> ship it', 'B -> hold it']);
    expect(park?.owes).toBe('information');
  });

  it('takes the newest record where the episode holds two', () => {
    const park = readPark({
      status: 'needs_info',
      waitingKind: null,
      moves: [{ to: 'needs_info', at: at(30), reason: null }],
      comments: [
        { id: 'old', body: parkBody('screen-review', 'developed'), createdAt: at(5) },
        { id: 'new', body: parkBody('question', 'approved'), createdAt: at(25) },
      ],
      openHumanQuestionIds: [],
    });
    expect(park?.resume).toEqual({ at: 'approved', recordId: 'new' });
  });

  it('never defaults a rung: no record says so', () => {
    const park = readPark({
      status: 'needs_info',
      waitingKind: null,
      moves: [
        { to: 'needs_info', at: at(20), reason: 'set outright' },
        { to: 'developed', at: at(10), reason: null },
      ],
      comments: [],
      openHumanQuestionIds: [],
    });
    expect(park?.resume.at).toBeNull();
    expect(park?.resume).toHaveProperty('why');
    expect(park?.record).toBeNull();
  });

  it('refuses a side status or a blank as the rung it left', () => {
    for (const left of ['on_hold', 'needs_info', 'draft', '', 'banana', 'unknown_status']) {
      const park = readPark({
        status: 'waiting',
        waitingKind: 'needs_resource',
        moves: [],
        comments: [{ id: 'c1', body: parkBody('blocked', left), createdAt: at(1) }],
        openHumanQuestionIds: [],
      });
      expect(park?.resume.at).toBeNull();
      expect(park?.record?.commentId).toBe('c1');
    }
  });

  it('ignores a comment that only mentions a record in prose', () => {
    const park = readPark({
      status: 'waiting',
      waitingKind: null,
      moves: [],
      comments: [{ id: 'c1', body: 'we wrote a forge-record: park earlier', createdAt: at(1) }],
      openHumanQuestionIds: [],
    });
    expect(park?.record).toBeNull();
    expect(park?.owes).toBeNull();
  });
});

describe('readPark — who it exists for', () => {
  it('is null at a working rung with no open question', () => {
    expect(
      readPark({
        status: 'testing',
        waitingKind: null,
        moves: [],
        comments: [],
        openHumanQuestionIds: [],
      }),
    ).toBeNull();
  });

  it('is a question at a working rung holding an open human question, with no rung to resume', () => {
    const park = readPark({
      status: 'testing',
      waitingKind: null,
      moves: [],
      comments: [],
      openHumanQuestionIds: ['q1'],
    });
    expect(park).toMatchObject({ shape: 'question', owes: 'information', openQuestionIds: ['q1'] });
    expect(park?.resume.at).toBeNull();
  });

  it('names a waiting park’s owes from its stored kind', () => {
    const owes = (waitingKind: 'needs_decision' | 'needs_resource' | null) =>
      readPark({
        status: 'waiting',
        waitingKind,
        moves: [],
        comments: [],
        openHumanQuestionIds: [],
      })?.owes;
    expect(owes('needs_decision')).toBe('decision');
    expect(owes('needs_resource')).toBe('resource');
    expect(owes(null)).toBeNull();
  });

  it('names a needs_info park rewritten from waiting by the kind it kept', () => {
    const park = readPark({
      status: 'needs_info',
      waitingKind: 'needs_resource',
      moves: [],
      comments: [],
      openHumanQuestionIds: [],
    });
    expect(park?.owes).toBe('resource');
  });
});
