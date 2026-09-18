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
vi.mock('../db/client.js', () => {
  const chain: Record<string, unknown> = {};
  for (const k of ['select', 'from', 'innerJoin', 'where', 'orderBy']) {
    chain[k] = () => chain;
  }
  chain.limit = () => Promise.resolve(rows.value);
  return { db: chain };
});
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { detectStrandedIssues } = await import('./stranded-issues.js');
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
