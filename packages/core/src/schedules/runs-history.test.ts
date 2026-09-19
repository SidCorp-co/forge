import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const fromTables: string[] = [];
let scheduleRow: { projectId: string; kind: string } | undefined;

function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    String(s).includes('drizzle:Name'),
  );
  return sym ? String((t as Record<symbol, unknown>)[sym]) : 'unknown';
}

/** A thenable that also answers every chain step `listScheduleRuns` uses. */
function chain(rows: unknown[]): Record<string, unknown> {
  const p = Promise.resolve(rows) as unknown as Record<string, unknown>;
  for (const step of ['where', 'orderBy', 'limit', 'leftJoin']) {
    p[step] = () => chain(rows);
  }
  return p;
}

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: (t: unknown) => {
        const name = tableName(t);
        fromTables.push(name);
        if (name === 'schedules') return chain(scheduleRow ? [scheduleRow] : []);
        if (name === 'schedule_runs') {
          return chain([
            {
              id: 'run-1',
              status: 'failed',
              trigger: 'scheduled',
              output: 'thresholds: 10 event(s), 2 user(s)',
              error: 'sentry pull: this project has no active Sentry binding',
              startedAt: new Date('2026-09-17T10:00:00Z'),
              finishedAt: new Date('2026-09-17T10:00:02Z'),
            },
          ]);
        }
        return chain([]);
      },
    }),
  },
}));

vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: async () => ({ role: 'owner' }),
  assertProjectRole: () => undefined,
}));

const { listScheduleRuns } = await import('./service.js');
const { isRunnerLessScheduleKind, RUNNER_LESS_SCHEDULE_KINDS, scheduleKinds } = await import(
  '../db/schema.js'
);

beforeEach(() => {
  fromTables.length = 0;
  scheduleRow = undefined;
});

describe('isRunnerLessScheduleKind', () => {
  it('names every kind that runs inside core and starts no agent session', () => {
    expect([...RUNNER_LESS_SCHEDULE_KINDS]).toEqual(['script', 'release_batch', 'sentry_pull']);
  });

  it('is false for the one kind that DOES open an agent session', () => {
    expect(isRunnerLessScheduleKind('prompt')).toBe(false);
  });

  it('partitions scheduleKinds with nothing left over', () => {
    const unaccounted = scheduleKinds.filter((k) => k !== 'prompt' && !isRunnerLessScheduleKind(k));
    expect(unaccounted).toEqual([]);
  });
});

describe('listScheduleRuns — the table each kind is read from', () => {
  it('reads schedule_runs for a sentry_pull schedule', async () => {
    scheduleRow = { projectId: 'p-1', kind: 'sentry_pull' };
    const { runs } = await listScheduleRuns('sched-1', 'user-1');
    expect(fromTables).toEqual(['schedules', 'schedule_runs']);
    expect(fromTables).not.toContain('agent_sessions');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'failed',
      error: 'sentry pull: this project has no active Sentry binding',
      output: 'thresholds: 10 event(s), 2 user(s)',
    });
  });

  it('reads schedule_runs for a release_batch schedule — the half of this that was already broken', async () => {
    scheduleRow = { projectId: 'p-1', kind: 'release_batch' };
    const { runs } = await listScheduleRuns('sched-2', 'user-1');
    expect(fromTables).toEqual(['schedules', 'schedule_runs']);
    expect(runs).toHaveLength(1);
  });

  it('still reads schedule_runs for a script schedule', async () => {
    scheduleRow = { projectId: 'p-1', kind: 'script' };
    await listScheduleRuns('sched-3', 'user-1');
    expect(fromTables).toEqual(['schedules', 'schedule_runs']);
  });

  it('still reads agent_sessions for a prompt schedule', async () => {
    scheduleRow = { projectId: 'p-1', kind: 'prompt' };
    await listScheduleRuns('sched-4', 'user-1');
    expect(fromTables).toContain('agent_sessions');
    expect(fromTables).not.toContain('schedule_runs');
  });
});
