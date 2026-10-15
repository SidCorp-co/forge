import { beforeEach, describe, expect, it, vi } from 'vitest';

const adminsFor = vi.fn(async (projectIds: readonly string[]) => {
  const out = new Map<string, string[]>();
  for (const id of projectIds) out.set(id, [`admin-of-${id}`]);
  return out;
});
vi.mock('../notifications/project-admins.js', () => ({
  projectAdminUserIdsFor: (ids: readonly string[]) => adminsFor(ids),
}));

const emitNotification = vi.fn(async () => ({ delivered: 1 }));
vi.mock('../notifications/emit.js', () => ({
  emitNotification: (...args: unknown[]) => emitNotification(...(args as [])),
}));

const rows = vi.hoisted(() => ({ value: [] as unknown[] }));
/** Every bound the detectors asked the database for, in call order. */
const limits = vi.hoisted(() => [] as unknown[]);
vi.mock('../db/client.js', () => {
  const chain: Record<string, unknown> = {};
  for (const k of ['select', 'from', 'innerJoin', 'where', 'orderBy']) {
    chain[k] = () => chain;
  }
  // The argument is RECORDED, not just swallowed. A stub that resolves whatever it is handed
  // returns 200 rows however large the bound was, so an assertion on the result cannot see a
  // `.limit(STRANDED_SCAN_LIMIT * 10)` at all.
  chain.limit = (n: unknown) => {
    limits.push(n);
    return Promise.resolve(rows.value);
  };
  return { db: chain };
});
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { detectStrandedIssues, detectOwedCloses, STRANDED_SCAN_LIMIT } = await import(
  './stranded-issues.js'
);
const { resetSweepCursorsForTest } = await import('./sweep-cursor.js');

function strand(projectId: string, i: number) {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    projectId,
    issuePrefix: 'ISS',
    issSeq: i,
    title: `strand ${i}`,
    mergedAt: null,
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    cursorTs: `2026-08-01 00:00:0${i}+00`,
    projectName: 'Seed',
  };
}

/** What the owed-close sweep reads: a row carrying a merge mark under a live status. */
function merged(projectId: string, i: number) {
  return {
    ...strand(projectId, i),
    status: 'developed',
    mergedAt: new Date('2026-08-01T00:00:00.000Z'),
    cursorTs: `2026-08-01 00:00:0${i}+00`,
  };
}

describe('detectStrandedIssues resolves each project once per pass (ISS-1021)', () => {
  beforeEach(() => {
    adminsFor.mockClear();
    emitNotification.mockClear();
    resetSweepCursorsForTest();
  });

  it('asks for the admin set ONCE however many rows the page holds', async () => {
    rows.value = [strand('p1', 1), strand('p1', 2), strand('p1', 3), strand('p1', 4)];

    await detectStrandedIssues();

    // Four strands, one question. With the per-row lookup back, this is 4.
    expect(adminsFor).toHaveBeenCalledTimes(1);
    expect(emitNotification).toHaveBeenCalledTimes(4);
  });

  it('asks once for a page spanning several projects, naming every one of them', async () => {
    rows.value = [strand('p1', 1), strand('p2', 2), strand('p3', 3), strand('p1', 4)];

    await detectStrandedIssues();

    expect(adminsFor).toHaveBeenCalledTimes(1);
    // Every project on the page reaches that one call — a batch that dropped one would leave its
    // strands with no admin, which this pass reports as `unreachable` rather than as an error.
    expect(adminsFor.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']));
  });
});

describe('detectOwedCloses carries the same memo and bound (ISS-1021)', () => {
  beforeEach(() => {
    adminsFor.mockClear();
    emitNotification.mockClear();
    resetSweepCursorsForTest();
  });

  it('asks for the admin set ONCE however many rows the page holds', async () => {
    rows.value = [merged('p1', 1), merged('p2', 2), merged('p1', 3), merged('p3', 4)];

    await detectOwedCloses();

    // Four rows, one question. With the per-row lookup back in this detector, this is 4 — and
    // nothing else in the module would have moved.
    expect(adminsFor).toHaveBeenCalledTimes(1);
    expect(adminsFor.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']));
  });

  it('asks the database for no more than its bound', async () => {
    limits.length = 0;
    rows.value = Array.from({ length: STRANDED_SCAN_LIMIT }, (_, i) => merged('p1', i + 1));

    const result = await detectOwedCloses();

    // The BOUND, read off the call, and the page the detector then consumed. The first is the
    // criterion; the second alone is not, because the stub returns the rows it was given whatever
    // number it was handed — a `.limit(STRANDED_SCAN_LIMIT * 10)` would leave `detected` at 200
    // and say nothing. `tests/integration/sweep-fair-traversal-e2e.test.ts` proves the bound
    // reaches real SQL for the sibling detector; this proves which number this one sends.
    expect({ bound: limits[0], detected: result.detected }).toEqual({
      bound: STRANDED_SCAN_LIMIT,
      detected: STRANDED_SCAN_LIMIT,
    });
  });
});

describe('a stranded pass that fills its page says so (ISS-1021 criterion 6)', () => {
  beforeEach(() => {
    adminsFor.mockClear();
    emitNotification.mockClear();
    resetSweepCursorsForTest();
  });

  // Both detectors, because they carry separate copies of the same block and a single case would
  // leave whichever one it did not name free to lose it silently.
  const detectors: Array<
    [string, () => Promise<unknown>, RegExp, (projectId: string, i: number) => object]
  > = [
    ['waiting-park', () => detectStrandedIssues(), /waiting-park scan filled its page/, strand],
    ['owed-close', () => detectOwedCloses(), /owed-close scan filled its page/, merged],
  ];

  it.each(detectors)(
    '%s names the bound and the count it examined',
    async (_n, run, message, row) => {
      const { logger } = await import('../logger.js');
      vi.mocked(logger.warn).mockClear();
      rows.value = Array.from({ length: STRANDED_SCAN_LIMIT }, (_, i) => row('p1', i + 1));

      await run();

      const warn = vi.mocked(logger.warn).mock.calls.find((c) => message.test(String(c[1])));
      expect(warn?.[0]).toMatchObject({
        limit: STRANDED_SCAN_LIMIT,
        examined: STRANDED_SCAN_LIMIT,
      });
    },
  );

  it.each(detectors)(
    '%s says nothing on a page that did not fill',
    async (_n, run, message, row) => {
      const { logger } = await import('../logger.js');
      vi.mocked(logger.warn).mockClear();
      rows.value = [row('p1', 1), row('p1', 2)];

      await run();

      expect(
        vi.mocked(logger.warn).mock.calls.find((c) => message.test(String(c[1]))),
      ).toBeUndefined();
    },
  );
});

describe('what a stranded notice says, in the words a reader uses (ISS-1229)', () => {
  const now = new Date('2026-08-04T06:00:00.000Z');

  beforeEach(() => {
    emitNotification.mockClear();
    resetSweepCursorsForTest();
  });

  function sent(): { title: string; body: string } {
    return (emitNotification.mock.calls[0] as unknown as [{ title: string; body: string }])[0];
  }

  it('says how long a waiting park has stood, in days, and names its project', async () => {
    rows.value = [strand('p1', 1)];
    await detectStrandedIssues(now);
    expect(sent().body).toBe('ISS-1 "strand 1": it has been parked for 3 days.');
    expect(sent().title).toBe('ISS-1 is waiting on you — Seed');
  });

  it('says how many hours, not the bare word, for a park younger than a day', async () => {
    rows.value = [{ ...strand('p1', 1), updatedAt: new Date('2026-08-03T23:00:00.000Z') }];
    await detectStrandedIssues(now);
    expect(sent().body).toBe('ISS-1 "strand 1": it has been parked for 7 hours.');
  });

  it('names an owed close by the status a person reads, never its stored form', async () => {
    rows.value = [{ ...merged('p1', 1), status: 'awaiting_release' }];
    await detectOwedCloses(now);
    expect(sent().body).toBe(
      'ISS-1 "strand 1" has carried a merge mark for 3 days while it still reads Awaiting release, with nothing running on it.',
    );
  });
});
