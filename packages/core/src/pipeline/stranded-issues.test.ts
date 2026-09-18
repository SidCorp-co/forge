import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ISS-1021 — the per-pass memo, counted rather than read.
 *
 * `surfaceOnce` used to resolve the project's admin set itself, once per ROW: measured on beta
 * 2026-09-17, 14 strands across 6 projects and 60 owed closes across 15 asked 222 queries a minute
 * for 21 distinct answers. The fix is one batched call hoisted out of the loop, and the only thing
 * that can go red for it is a CALL COUNT — the returned notifications are identical either way, so
 * every other assertion in this module passes with the per-row lookup back in place.
 */
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

// ISS-1021 criteria 2, 3 and 6, for the half of this module nothing reached. Measured while
// re-judging on 2026-09-18: every assertion above is about `detectStrandedIssues`, and
// `detectOwedCloses` — which carries the same memo, the same bound and the same truncation warn —
// had no unit coverage at all, while `tests/integration/owed-close-e2e.test.ts` seeds one row per
// case and so reaches none of the three. The page-filled warn had no assertion on either detector.
describe('detectOwedCloses carries the same memo and bound (ISS-1021)', () => {
  beforeEach(() => {
    adminsFor.mockClear();
    emitNotification.mockClear();
    resetSweepCursorsForTest();
  });

  it('asks for the admin set ONCE however many rows the page holds', async () => {
    rows.value = [strand('p1', 1), strand('p2', 2), strand('p1', 3), strand('p3', 4)];

    await detectOwedCloses();

    // Four rows, one question. With the per-row lookup back in this detector, this is 4 — and
    // nothing else in the module would have moved.
    expect(adminsFor).toHaveBeenCalledTimes(1);
    expect(adminsFor.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']));
  });

  it('asks the database for no more than its bound', async () => {
    limits.length = 0;
    rows.value = Array.from({ length: STRANDED_SCAN_LIMIT }, (_, i) => strand('p1', i + 1));

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
  const detectors: Array<[string, () => Promise<unknown>, RegExp]> = [
    ['waiting-park', () => detectStrandedIssues(), /waiting-park scan filled its page/],
    ['owed-close', () => detectOwedCloses(), /owed-close scan filled its page/],
  ];

  it.each(detectors)('%s names the bound and the count it examined', async (_n, run, message) => {
    const { logger } = await import('../logger.js');
    vi.mocked(logger.warn).mockClear();
    rows.value = Array.from({ length: STRANDED_SCAN_LIMIT }, (_, i) => strand('p1', i + 1));

    await run();

    const warn = vi.mocked(logger.warn).mock.calls.find((c) => message.test(String(c[1])));
    expect(warn?.[0]).toMatchObject({ limit: STRANDED_SCAN_LIMIT, examined: STRANDED_SCAN_LIMIT });
  });

  it.each(detectors)('%s says nothing on a page that did not fill', async (_n, run, message) => {
    const { logger } = await import('../logger.js');
    vi.mocked(logger.warn).mockClear();
    rows.value = [strand('p1', 1), strand('p1', 2)];

    await run();

    expect(
      vi.mocked(logger.warn).mock.calls.find((c) => message.test(String(c[1]))),
    ).toBeUndefined();
  });
});
