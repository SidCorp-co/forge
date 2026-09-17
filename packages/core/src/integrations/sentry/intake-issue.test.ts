/**
 * ISS-1085 slice 4 — the ONE decision both doors make about one Sentry issue.
 *
 * The db is mocked, so what these assert is the statements core issues and the values it puts in
 * them. Two things are asserted against the REAL thing rather than a mock on purpose: the admission
 * gate, because "the same gate the pull calls" is a claim about which function runs; and
 * `isReopenEntry`, because the counter this change relies on is incremented by the state machine
 * for one specific `(from, to)` pair, and a test that mocked the transition and then asserted the
 * increment itself would be asserting its own mock.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isReopenEntry } from '../../pipeline/state-machine.js';

const executed: string[] = [];
const updateSets: Record<string, unknown>[] = [];
const insertedComments: Record<string, unknown>[] = [];
const selectRows: unknown[][] = [];
const executeAnswer: unknown[][] = [];
const transactions: number[] = [];

/** `select().from().where()[.for('update')].limit()` — a thenable answering every chain step. */
function selectChain() {
  const rows = selectRows.shift() ?? [];
  const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  p.limit = () => Promise.resolve(rows);
  p.for = () => p;
  return p;
}

const handle = {
  execute: (q: unknown) => {
    executed.push(JSON.stringify(q));
    return Promise.resolve(executeAnswer.shift() ?? [{ id: 'new-issue-1' }]);
  },
  select: () => ({ from: () => ({ where: () => selectChain() }) }),
  update: () => ({
    set: (patch: Record<string, unknown>) => {
      updateSets.push(patch);
      return { where: () => Promise.resolve(undefined) };
    },
  }),
  insert: () => ({
    values: (v: Record<string, unknown>) => {
      insertedComments.push(v);
      return Promise.resolve(undefined);
    },
  }),
};

vi.mock('../../db/client.js', () => ({
  db: {
    ...handle,
    transaction: (fn: (tx: typeof handle) => Promise<unknown>) => {
      transactions.push(1);
      return fn(handle);
    },
  },
}));

const transitionMock = vi.fn(async (..._a: unknown[]) => ({
  id: 'i1',
  status: 'reopen',
  reopenCount: 1,
}));
vi.mock('../../issues/apply-transition.js', () => ({
  transitionIssueStatus: (...a: unknown[]) => transitionMock(...(a as [])),
}));

const readThresholdsMock = vi.fn(async () => ({ sentryMinEventCount: 10, sentryMinUserCount: 2 }));
vi.mock('../../admin/thresholds.js', () => ({ readThresholds: () => readThresholdsMock() }));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// cm:guard the admission gate is the REAL one behind a spy, never a stub. Stubbing it would make "the webhook is judged by the same gate the pull calls" a claim about this file's mock, and the assertion could not go red if a second gate were written.
const judgeSpy = vi.fn();
vi.mock('./admission.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./admission.js')>();
  return {
    ...actual,
    judgeSentryIssue: (...a: Parameters<typeof actual.judgeSentryIssue>) => {
      judgeSpy(...a);
      return actual.judgeSentryIssue(...a);
    },
  };
});

const { intakeSentryIssue, readSentryThresholds, SENTRY_REGRESSED_SUBSTATUS } = await import(
  './intake-issue.js'
);

const PROJECT = '11111111-1111-4111-8111-111111111111';
const TARGET = { label: 'forge-core', organizationSlug: 'canawan', projectSlug: 'forge-core' };
const THRESHOLDS = { minEventCount: 10, minUserCount: 2 };

function issue(over: Record<string, unknown> = {}) {
  return {
    id: '4411',
    shortId: 'FORGE-CORE-9K',
    status: 'unresolved',
    substatus: 'new',
    level: 'error',
    count: 41,
    userCount: 9,
    firstSeen: '2026-09-01T00:00:00Z',
    lastSeen: '2026-09-17T00:00:00Z',
    permalink: 'https://logs.canawan.com/issues/4411/',
    projectSlug: 'forge-core',
    title: 'TypeError: cannot read property of undefined',
    culprit: 'app/routes/chat.tsx',
    metadataValue: 'boom',
    ...over,
  } as Parameters<typeof intakeSentryIssue>[0];
}

const ctx = { projectId: PROJECT, createdById: 'user-1', thresholds: THRESHOLDS, target: TARGET };

/** The transition this run requested, or a throw naming the invariant the caller assumed. */
function requestedTransition(): unknown[] {
  const call = transitionMock.mock.calls[0];
  if (!call) throw new Error('no status transition was requested');
  return call as unknown[];
}

/** The metadata merges this run issued, rendered as the SQL postgres would execute. */
function mergedMetadata(): string {
  return updateSets
    .map((u) => {
      const q = new PgDialect().sqlToQuery(u.metadata as never);
      return `${q.sql} ${JSON.stringify(q.params)}`;
    })
    .join('\n');
}

/** One already-filed Forge issue for the lookup to answer with. */
function filed(over: Record<string, unknown> = {}) {
  return {
    id: 'issue-1',
    projectId: PROJECT,
    status: 'draft',
    reopenCount: 0,
    metadata: { sentry: { shortId: 'FORGE-CORE-9K', count: 41 } },
    ...over,
  };
}

beforeEach(() => {
  executed.length = 0;
  updateSets.length = 0;
  insertedComments.length = 0;
  selectRows.length = 0;
  executeAnswer.length = 0;
  transactions.length = 0;
  vi.clearAllMocks();
  transitionMock.mockResolvedValue({ id: 'i1', status: 'reopen', reopenCount: 1 });
  readThresholdsMock.mockResolvedValue({ sentryMinEventCount: 10, sentryMinUserCount: 2 });
});

describe('an error that is not yet work', () => {
  it('is judged by the admission gate this module shares with the pull', async () => {
    selectRows.push([]);
    await intakeSentryIssue(issue(), ctx);
    expect(judgeSpy).toHaveBeenCalledTimes(1);
    expect(judgeSpy.mock.calls[0]?.[1]).toEqual(THRESHOLDS);
  });

  it('is refused below the event threshold, naming the count and the threshold', async () => {
    selectRows.push([]);
    const out = await intakeSentryIssue(issue({ count: 3 }), ctx);
    expect(out).toMatchObject({ kind: 'refused' });
    expect((out as { reason: string }).reason).toContain('3 event(s)');
    expect((out as { reason: string }).reason).toContain('threshold of 10');
    expect(executed).toHaveLength(0);
  });

  it('is refused below the affected-user threshold, naming both numbers', async () => {
    selectRows.push([]);
    const out = await intakeSentryIssue(issue({ userCount: 1 }), ctx);
    expect((out as { reason: string }).reason).toContain('1 user(s)');
    expect((out as { reason: string }).reason).toContain('threshold of 2');
    expect(executed).toHaveLength(0);
  });

  it('is filed at draft, carrying source sentry, when it passes', async () => {
    selectRows.push([]);
    const out = await intakeSentryIssue(issue(), ctx);
    expect(out).toEqual({ kind: 'filed' });
    const stmt = executed[0] ?? '';
    expect(stmt).toContain('"draft"');
    expect(stmt).toContain('"sentry"');
    expect(stmt).toContain('"FORGE-CORE-9K"');
  });

  // cm:guard the insert names its columns, and priority, category and label are NOT among them. That absence is the structural half of the injection chokepoint: no amount of Sentry text can steer a field the statement never writes, which is provable about a shape and only arguable about a code path.
  it('writes no column Sentry text could steer', async () => {
    selectRows.push([]);
    await intakeSentryIssue(issue(), ctx);
    const stmt = executed[0] ?? '';
    expect(stmt).not.toContain('priority');
    expect(stmt).not.toContain('category');
    expect(stmt).not.toContain('label');
  });

  it('writes the literal draft rather than any status the payload carried', async () => {
    selectRows.push([]);
    await intakeSentryIssue(issue({ status: 'unresolved', substatus: 'escalating' }), ctx);
    const stmt = executed[0] ?? '';
    expect(stmt).toContain('"draft"');
    expect(stmt).not.toContain('"escalating"');
  });
});

describe('an error that is already work', () => {
  it('is observed rather than filed a second time', async () => {
    selectRows.push([filed()], [filed()]);
    const out = await intakeSentryIssue(issue(), ctx);
    expect(out).toEqual({ kind: 'refreshed' });
    expect(executed).toHaveLength(0);
  });

  // cm:guard the gate must NOT be consulted for an issue that already exists. Consulting it would let an operator raising a threshold today silently stop the count updates on the issues that threshold had already admitted — a change to intake policy reaching back over rows it was never about.
  it('is never re-judged, even after the thresholds are raised above its counts', async () => {
    selectRows.push([filed()], [filed()]);
    const out = await intakeSentryIssue(issue({ count: 41 }), {
      ...ctx,
      thresholds: { minEventCount: 1000, minUserCount: 1000 },
    });
    expect(out).toEqual({ kind: 'refreshed' });
    expect(judgeSpy).not.toHaveBeenCalled();
  });

  it('posts one count-observation comment where the count has grown', async () => {
    selectRows.push([filed()], [filed({ metadata: { sentry: { count: 17 } } })]);
    const out = await intakeSentryIssue(issue({ count: 41 }), ctx);
    expect(out).toEqual({ kind: 'commented' });
    expect(insertedComments).toHaveLength(1);
    expect(String(insertedComments[0]?.body)).toContain('(was 17)');
  });

  it('posts no count-observation comment where the count has not grown', async () => {
    selectRows.push([filed()], [filed({ metadata: { sentry: { count: 41 } } })]);
    const out = await intakeSentryIssue(issue({ count: 41 }), ctx);
    expect(out).toEqual({ kind: 'refreshed' });
    expect(insertedComments).toHaveLength(0);
  });
});

describe('an error that came back after somebody called it done', () => {
  const regressed = { substatus: SENTRY_REGRESSED_SUBSTATUS };

  it('reopens the closed Forge issue holding it', async () => {
    selectRows.push([filed({ status: 'closed', reopenCount: 2 })], [filed({ status: 'closed' })]);
    const out = await intakeSentryIssue(issue(regressed), ctx);
    expect(out).toEqual({ kind: 'reopened' });
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(requestedTransition()[0]).toMatchObject({ id: 'issue-1', status: 'closed' });
    expect(requestedTransition()[1]).toBe('reopen');
  });

  // cm:guard the counter is the state machine's, incremented for exactly the `(closed, reopen)` pair this code requests. Asserting the increment against a mocked transition would be asserting the mock; asserting the PAIR against the real `isReopenEntry` is the half this module can honestly own.
  it('requests the one transition pair the state machine counts as a reopen', async () => {
    selectRows.push([filed({ status: 'closed' })], [filed({ status: 'closed' })]);
    await intakeSentryIssue(issue(regressed), ctx);
    const call = requestedTransition();
    const from = (call[0] as { status: string }).status;
    const to = call[1] as string;
    expect(isReopenEntry(from as never, to as never)).toBe(true);
  });

  it('carries an authored reason naming Sentry as the evidence', async () => {
    selectRows.push([filed({ status: 'closed' })], [filed({ status: 'closed' })]);
    await intakeSentryIssue(issue(regressed), ctx);
    const opts = requestedTransition()[3] as { transitionReason?: string };
    expect(opts.transitionReason).toContain('Sentry');
    expect(opts.transitionReason).toContain('FORGE-CORE-9K');
    expect(opts.transitionReason).toContain('regressed');
  });

  // cm:guard the actor carries an EXPLICIT `agency: null`, which `actor-agency.ts` reads as unestablished and fails closed to `agent`. An ABSENT agency reads `human`, which would put a delivery from outside behind the gates written for a person at a keyboard.
  it('attributes the move to a credential owner with no person at the keyboard', async () => {
    selectRows.push([filed({ status: 'closed' })], [filed({ status: 'closed' })]);
    await intakeSentryIssue(issue(regressed), ctx);
    expect(requestedTransition()[2]).toEqual({
      type: 'user',
      id: 'user-1',
      agency: null,
    });
  });

  // cm:guard `dropped` is a PERSON deciding not to fix this, which recurrence does not contradict. Reopening it would be a monitoring signal overruling a human decision.
  it('leaves a dropped issue dropped, and says so by name', async () => {
    selectRows.push([filed({ status: 'dropped' })], [filed({ status: 'dropped' })]);
    const out = await intakeSentryIssue(issue(regressed), ctx);
    expect(out).toMatchObject({ kind: 'refused' });
    expect((out as { reason: string }).reason).toContain('dropped');
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it.each(['draft', 'open', 'in_progress', 'awaiting_release'])(
    'moves no status for a regression against a %s issue',
    async (status) => {
      selectRows.push([filed({ status })], [filed({ status })]);
      const out = await intakeSentryIssue(issue(regressed), ctx);
      expect(out).toEqual({ kind: 'refreshed' });
      expect(transitionMock).not.toHaveBeenCalled();
    },
  );

  it('files no second issue for a shortId that already names one', async () => {
    selectRows.push([filed({ status: 'closed' })], [filed({ status: 'closed' })]);
    await intakeSentryIssue(issue(regressed), ctx);
    expect(executed).toHaveLength(0);
  });

  // cm:guard the observation is made durable BEFORE the transition is attempted. Ordered the other way, a transition that threw would throw away the sighting with it, and the next delivery would compare against a stale baseline and call a real increase no growth.
  it('refreshes the counts before it attempts the transition', async () => {
    selectRows.push([filed({ status: 'closed' })], [filed({ status: 'closed' })]);
    await intakeSentryIssue(issue(regressed), ctx);
    expect(transactions).toHaveLength(1);
    expect(updateSets.length).toBeGreaterThanOrEqual(1);
    expect(transitionMock).toHaveBeenCalledTimes(1);
  });

  // cm:guard the review's F3. Sentry RE-DELIVERS a hook that failed, carrying an identical body. Without a per-recurrence watermark, a regression that reopened an issue somebody then closed again would reopen it a second time off the replay — a counter incremented and a second reason posted for a recurrence that happened once.
  it('does not reopen twice for the same recurrence re-delivered', async () => {
    const seen = '2026-09-17T00:00:00Z';
    selectRows.push(
      [filed({ status: 'closed' })],
      [filed({ status: 'closed', metadata: { sentry: { count: 41, reopenedAtLastSeen: seen } } })],
    );
    const out = await intakeSentryIssue(issue({ ...regressed, lastSeen: seen }), ctx);
    expect(out).toMatchObject({ kind: 'refused' });
    expect((out as { reason: string }).reason).toContain('not newer');
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('reopens again for a genuinely later recurrence', async () => {
    selectRows.push(
      [filed({ status: 'closed' })],
      [
        filed({
          status: 'closed',
          metadata: { sentry: { count: 41, reopenedAtLastSeen: '2026-09-17T00:00:00Z' } },
        }),
      ],
    );
    const out = await intakeSentryIssue(
      issue({ ...regressed, lastSeen: '2026-09-18T00:00:00Z' }),
      ctx,
    );
    expect(out).toEqual({ kind: 'reopened' });
    expect(transitionMock).toHaveBeenCalledTimes(1);
  });

  // cm:guard the watermark must be the recurrence a REOPEN was done for, never the last time anything was seen. Keyed on `lastSeen` alone, an ordinary observation by the scheduled pull would advance it and the webhook delivering the genuine regression a moment later would find them equal and decline — a regression lost to the other door having looked first.
  it('reopens even where an ordinary observation already advanced lastSeen', async () => {
    const seen = '2026-09-18T00:00:00Z';
    selectRows.push(
      [filed({ status: 'closed' })],
      [filed({ status: 'closed', metadata: { sentry: { count: 41, lastSeen: seen } } })],
    );
    const out = await intakeSentryIssue(issue({ ...regressed, lastSeen: seen }), ctx);
    expect(out).toEqual({ kind: 'reopened' });
  });

  it('stamps the recurrence it reopened for, so the next delivery can tell', async () => {
    const seen = '2026-09-18T00:00:00Z';
    selectRows.push([filed({ status: 'closed' })], [filed({ status: 'closed' })]);
    await intakeSentryIssue(issue({ ...regressed, lastSeen: seen }), ctx);
    const merged = mergedMetadata();
    expect(merged).toContain('reopenedAtLastSeen');
    expect(merged).toContain(seen);
  });

  // cm:guard the review's F2 second case. Equality let a SUPERSEDED recurrence through: T1 handled, T2 handled, the issue closed again, T1 re-delivered — T1 is not equal to the T2 watermark, so an equality test reopens completed work off a replay of something already overtaken.
  it('does not reopen for a recurrence older than the one already reopened for', async () => {
    selectRows.push(
      [filed({ status: 'closed' })],
      [
        filed({
          status: 'closed',
          metadata: { sentry: { count: 41, reopenedAtLastSeen: '2026-09-18T00:00:00Z' } },
        }),
      ],
    );
    const out = await intakeSentryIssue(
      issue({ ...regressed, lastSeen: '2026-09-17T00:00:00Z' }),
      ctx,
    );
    expect(out).toMatchObject({ kind: 'refused' });
    expect((out as { reason: string }).reason).toContain('not newer');
    expect(transitionMock).not.toHaveBeenCalled();
  });

  // cm:guard a recurrence Sentry did not timestamp cannot be told apart from one already acted on, so it is refused by name rather than reopened on a guess — the same rule the admission gate applies to an absent count. Without this an identical redelivery reopens on every attempt, forever.
  it('refuses by name a regression Sentry did not timestamp', async () => {
    selectRows.push([filed({ status: 'closed' })], [filed({ status: 'closed' })]);
    const out = await intakeSentryIssue(issue({ ...regressed, lastSeen: null }), ctx);
    expect(out).toMatchObject({ kind: 'refused' });
    expect((out as { reason: string }).reason).toContain('no usable time');
    expect(transitionMock).not.toHaveBeenCalled();
  });

  // cm:guard the review's F1. The stamp must touch ONE key. Rebuilt from the pre-transition snapshot it replaced the whole sentry object, so a count another delivery committed in between was overwritten with the older one — and the next observation of the newer count then read as growth and posted a duplicate comment.
  it('stamps the watermark without rewriting the rest of the sentry record', async () => {
    selectRows.push([filed({ status: 'closed' })], [filed({ status: 'closed' })]);
    await intakeSentryIssue(issue({ ...regressed, lastSeen: '2026-09-18T00:00:00Z' }), ctx);
    const stamp = updateSets.at(-1);
    const rendered = new PgDialect().sqlToQuery(stamp?.metadata as never);
    expect(rendered.sql).toContain('jsonb_set');
    expect(JSON.stringify(rendered.params)).toContain('reopenedAtLastSeen');
    // The stamp carries the watermark and NOTHING else — no count, no userCount, no seenAt.
    expect(JSON.stringify(rendered.params)).not.toContain('seenAt');
    expect(JSON.stringify(rendered.params)).not.toContain('userCount');
  });

  it('does not reopen an issue Sentry did not report as regressed', async () => {
    selectRows.push([filed({ status: 'closed' })], [filed({ status: 'closed' })]);
    const out = await intakeSentryIssue(issue({ substatus: 'ongoing' }), ctx);
    expect(out).toEqual({ kind: 'refreshed' });
    expect(transitionMock).not.toHaveBeenCalled();
  });
});

describe('the thresholds both doors judge against', () => {
  // cm:guard read through one function so the webhook and the pull cannot end up judging against different numbers. Thresholds are operator policy and change without a deploy (ISS-654), so a door holding its own constant would keep filing at the old bound with nothing saying the two disagreed.
  it('come from admin_thresholds rather than from a constant', async () => {
    readThresholdsMock.mockResolvedValue({ sentryMinEventCount: 25, sentryMinUserCount: 4 });
    await expect(readSentryThresholds()).resolves.toEqual({
      minEventCount: 25,
      minUserCount: 4,
    });
    expect(readThresholdsMock).toHaveBeenCalledTimes(1);
  });
});
